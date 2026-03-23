# Webhook URL not found issue
_Exported on 3/23/2026 at 16:58:50 GMT from Cursor (2.4.22)_

---

**User**

A user is getting the error we print  within PagerDutyMessageConsumer.java ->  LoggingUtil.info(logger, null, CLASS_NAME, "User id not found for webhook URL: " + webhookUrl);

The webhook URL is being logged in our logs though, it just seems to not be found within the backend tables. Any idea what could cause this? They say it used to work and then stopped suddenly so now they don't get notifications sent to their webex space.


---

**Cursor**


Tracing how the PagerDuty consumer resolves a webhook URL to a user ID and which data sources it uses.




Tracing the PagerDuty flow: where the webhook URL is published to Kafka and how `handleEvent` behaves when the user ID is missing.




Here is what that log actually means and what usually causes it.

## What the code is doing

The message is emitted when `findUserIdByWebhookUrl(webhookUrl)` returns `null`:

```177:183:c:\Users\ralagana\Documents\webex-bot-service\bots\pagerduty\src\main\java\com\ciscospark\webexbot\pagerduty\service\PagerDutyMessageConsumer.java
                if (webhookUrl != null && !webhookUrl.isEmpty()) {
                    String userId = notificationSettingsRepositoryWrapper.findUserIdByWebhookUrl(webhookUrl);
                    if (userId != null) {
                        LoggingUtil.info(logger, userId, CLASS_NAME, "Received kafka message for Pagerduty Notification for user: " + userId);
                    } else {
                        LoggingUtil.info(logger, null, CLASS_NAME, "User id not found for webhook URL: " + webhookUrl);
                    }
```

That method is a **database join**: `notificationsettings` → `webhookmaster` on `webhookid`, filtered by **exact** `webhookUrl`:

```46:49:c:\Users\ralagana\Documents\webex-bot-service\bots-common\src\main\java\com\ciscospark\webexbot\common\repository\NotificationSettingsRepository.java
    @Query(value = "SELECT ns.userid FROM notificationsettings ns " +
            "JOIN webhookmaster wm ON ns.webhookid = wm.webhookid " +
            "WHERE wm.webhookUrl = :webhookUrl", nativeQuery = true)
    String findUserIdByWebhookUrl(@Param("webhookUrl") String webhookUrl);
```

So a `null` user id means: **there is no row that ties that exact URL to a notification** (either no `webhookmaster` row for that string, or no `notificationsettings` row pointing at that webhook).

The URL you see in logs is whatever was passed on the HTTP callback as the `{webhookUrl}` path segment:

```55:86:c:\Users\ralagana\Documents\webex-bot-service\bots-common\src\main\java\com\ciscospark\webexbot\common\controller\AppController.java
    @PostMapping("/manage/events/{botName}/{webhookUrl}")
    public ResponseEntity<String> handleNotificationEvent(..., @PathVariable String webhookUrl, ...) {
        ...
            subJsonObject.put("webhookUrl", webhookUrl);
```

So the lookup string is **the decoded path variable**, not the PagerDuty “integration URL” from the JSON body unless that same value was configured as the path.

## Likely reasons it “used to work” then stopped

1. **PagerDuty URL changed**  
   Regenerating the integration, changing service, or PagerDuty changing the inbound URL means callbacks hit your app with a **new** path value. The DB still has the **old** `webhookmaster.webhookUrl` → join fails. Very common.

2. **Notification row gone, webhook row maybe still there (or vice versa)**  
   `userid` only comes from `notificationsettings`. If notification was removed (user deleted the notification, bot removed from space, cleanup job, partial delete) but someone still sees a row in **`webhookmaster`** only, you get “user id not found” semantics: **no linked notification**.  
   Conversely, if they only look at `notificationsettings` and the path URL does not match `webhookmaster.webhookUrl` exactly, the join also fails.

3. **Exact string mismatch**  
   Comparison is exact: encoding differences (`%2F` vs `/`), trailing slash, `http` vs `https`, extra query params, case, or a proxy rewriting the path can all produce a string that **logs “reasonably”** but does not equal the stored value.

4. **Follow-on failure in `handleEvent` (worth checking logs)**  
   If `webhookmaster` still has the URL but `getNotificationIdByWebhookUrl` returns `null`, this line can throw when unboxing to `int`:

```93:96:c:\Users\ralagana\Documents\webex-bot-service\bots\pagerduty\src\main\java\com\ciscospark\webexbot\pagerduty\service\PagerDutyNotificationService.java
        String userId = notificationSettingsRepositoryWrapper.findUserIdByWebhookUrl(webhookUrl);
        String eventType = notificationEventPayload.getEvent().getEventType();
        int notificationId = notificationSettingsService.getNotificationIdByWebhookUrl(webhookUrl);
        String eventTypeFromDB = notificationSettingsRepositoryWrapper.getEventType(notificationId);
```

   So also search for **`Error in pagerduty third party topic listenGroup`** (e.g. NPE) around the same time.

## What to have them verify (ops / DB)

- Compare **logged `webhookUrl`** byte-for-byte with **`webhookmaster.webhookUrl`** for their integration.  
- Confirm a **`notificationsettings` row** exists with `webhookid` = that webhook’s id (not only a row in `webhookmaster`).  
- If PagerDuty shows a **new** integration URL, they need to **re-run the Webex bot setup** so the service stores the new URL (or update the integration URL in PagerDuty to match what is still in the DB—usually re-setup is safer).

**Security note:** Treat full webhook URLs as secrets in runbooks; they are capability URLs.

---

**How the “no hardcoded credentials” rule applies:** This answer does not add or rely on secrets in code; it only explains existing lookups and recommends verifying DB rows and URL equality without embedding credentials.

---

**User**

how can we get into this state though? Any ideas?

---

**Cursor**


Tracing code paths that can leave a webhook URL without a linked `notificationsettings` row (or with a mismatched URL).




Here are concrete ways the system can end up with **PagerDuty still calling your URL** while **`findUserIdByWebhookUrl` returns null** (no `notificationsettings` row joined to that `webhookmaster` URL).

## 1. Orphan `webhookmaster` row (most important in this codebase)

Notification creation **always registers the webhook with PagerDuty first**, then persists locally:

```1078:1092:c:\Users\ralagana\Documents\webex-bot-service\bots-common\src\main\java\com\ciscospark\webexbot\common\controller\MicrositeController.java
        try {
            Map<String, String> responseData = apiService.createWebHook(botName, userId, webhookData);

            if (!responseData.get(Constants.STATUS).equals(Constants.SUCCESS)) {
                return ResponseEntity.badRequest().body(responseData);
            }

            JsonNode jsonNode = objectMapper.readTree(responseData.get(Constants.MESSAGE));
            String webhookDetails = botSpecificService.getWebhookDetails(jsonNode);
            String[] webhook = webhookDetails.split("/");
            String webhookRegistrationId = (webhook.length > 0 && !webhook[0].equals("null")) ? webhook[0] : null;
            LoggingUtil.info(logger, userId, CLASS_NAME, "Webhook registration id: {}", webhookRegistrationId);
            String webhookUrl = (webhook.length > 1) ? webhook[1] : "NA";
            saveNotification(request, botName, notificationName, webhookUrl, webhookRegistrationId, authId, messageType, message, false, responseData);
```

Inside `saveNotification`, **`webhookmaster` is inserted first**, then notification settings:

```1297:1303:c:\Users\ralagana\Documents\webex-bot-service\bots-common\src\main\java\com\ciscospark\webexbot\common\controller\MicrositeController.java
        WebhookMaster savedWebhook = createNotificationService.saveWebhookMaster(isManual, webhookRegistrationId, webhookUrl, expirationDateTime);
        int webhookId = savedWebhook.getWebhookId();

        String customData = botSpecificService.prepareNotificationCustomDataToSave(request, responseData, userId);

        createNotificationService.saveNotificationSettings(
                messageType, message, eventTypes, notificationName, userId, authId, botId, spaceId, customData, webhookId);
```

But `saveNotificationSettings` can **exit without saving** if there is no bot membership for the space/bot in the request:

```91:94:c:\Users\ralagana\Documents\webex-bot-service\bots-common\src\main\java\com\ciscospark\webexbot\common\service\CreateNotificationService.java
        String membershipId = botMembershipService.getMembershipIdBySpaceIdAndBotId(spaceId, botId);
        if (membershipId == null) {
            LoggingUtil.info(logger, userId, CLASS_NAME, "MembershipId not found for spaceID:" + spaceId);
            return;
```

There is **no transaction** rolling back the `webhookmaster` insert, and `createNonManualNotification` still returns **success** after `saveNotification` returns. So you can get:

- PagerDuty subscription → your `{baseUrl}/manage/events/pagerduty/{id}`  
- A row in **`webhookmaster`** with that `id`  
- **No** row in **`notificationsettings`**  
- Incoming events: URL matches `webhookmaster`, join for `userid` returns nothing → **“User id not found”**.

That fits “it used to work” if something later removed membership or the UI sent a **stale `spaceId`**, or the bot was kicked from the space while the user finished the linking flow.

## 2. Partial cleanup when deleting notifications

War-room style cleanup deletes the notification row, then the webhook row:

```314:318:c:\Users\ralagana\Documents\webex-bot-service\bots\pagerduty\src\main\java\com\ciscospark\webexbot\pagerduty\service\IncidentService.java
            int webhookId = notificationSettingsService.getWebhookIdByNotificationId(notificationId);
            notificationSettingsRepositoryWrapper.deleteById(notificationId);
            LoggingUtil.info(logger, userId, CLASS_NAME, "Deleted data in notificationSettings");
            webhookMasterRepositoryWrapper.deleteById(webhookId);
            LoggingUtil.info(logger, userId, CLASS_NAME, "Deleted data in webhookMaster");
```

If **`deleteById` on `webhookmaster` fails** (DB error, constraint, etc.) after `notificationsettings` was removed, you again get a **webhook URL still in `webhookmaster`** with **no** notification — same symptom. PagerDuty may keep sending until the subscription is removed on their side.

## 3. External / product-side changes (no code bug required)

- **PagerDuty subscription URL** regenerated or edited so the path segment no longer matches `webhookmaster.webhookUrl`, while logs show “some” URL (often confused with the integration URL in the PD UI).  
- **Manual** misconfiguration: URL pasted into PagerDuty does not match what you store (full URL vs last path segment — your PD integration uses a **single path segment** from `Util.generateUniqueId` in `buildRequestBody`, and `getWebhookDetails` also uses the segment after the last `/`).

---

**Practical check:** For the logged path segment, query `webhookmaster` and see if there is a matching `notificationsettings.webhookid`. If `webhookmaster` exists alone, search logs for **`MembershipId not found for spaceID`** around the time the notification was “created”; that is the smoking gun for scenario 1.

**Codeguard / no hardcoded credentials:** This analysis only references existing code paths and operational data; no secrets were introduced.

---

**User**

ok I've fetched and rebased to pull some recent changes to the project from master. There were some changes specifically related to an issue with pagerduty notification update/delete flows. Can you check these changes to see whether they may have introduced some bugs that could be causing the issue we discussed earlier?

---

**Cursor**


Inspecting recent git history and diffs for PagerDuty notification update/delete changes.




Tracing the full delete/update flows and `deleteWebHook` contract after the PR.




Here’s a concise review of **PR #622** (`3a4f6363` – PagerDuty update/delete authorization) and how it relates to the **“User id not found for webhook URL”** situation.

## What the PR changed

- **`deleteNotification(notificationId, authId)`** now passes **`authId`** into **`BotWebhookData`** so PagerDuty delete/update use the **UI-selected** credential instead of always reading auth from the DB.
- **`PagerDutyAPIService.deleteWebHook`** returns a **`Map`** (`success` / `error`) instead of void + throws; **404** on delete is treated like success (subscription already gone).
- **`NotificationSettingsService.deleteNotification`** only removes local **`webhookmaster` + `notificationsettings`** if the external delete returns **status ≠ error** (so failed PD deletes no longer wipe DB silently).
- **`PagerDutyCommandService`** space cleanup calls **`deleteNotification(id, 0)`**; PD delete uses **`authId == 0`** to mean “load auth from DB via `notificationId`” (see below).

---

## Bug / gap that this PR plausibly worsens

### 1. **Update flow ignores `deleteNotification` result** (real bug)

In **`updateNonManualNotification`**, when the API response has **`type == "create"`**, the code calls **`deleteNotification(notificationId, authId)`** but **never checks the returned `Map`**:

```1432:1457:c:\Users\ralagana\Documents\webex-bot-service\bots-common\src\main\java\com\ciscospark\webexbot\common\controller\MicrositeController.java
        if (response.get(Constants.STATUS).equals(Constants.SUCCESS)) {
            String customData = botSpecificService.prepareNotificationCustomDataToSave(request, response, userId);
            if (response.get(Constants.TYPE) != null && response.get(Constants.TYPE).equals("create")) {
                notificationSettingsService.deleteNotification(notificationId, authId);
                JsonNode createNode = objectMapper.readTree(response.get(Constants.MESSAGE));
                ...
                WebhookMaster savedWebhook = createNotificationService.saveWebhookMaster(false, webhookRegistrationId, webhookUrl, expirationDateTime);
                ...
                createNotificationService.saveNotificationSettings(
                        messageType, message, eventTypes, notificationName, userId, authId, botId, spaceId, customData, webhookId);
```

**Before**, a failing PD delete often **threw** and stopped the method. **Now**, delete can **return error** and the code **still**:

- inserts a **new** `webhookmaster` row, and  
- runs **`saveNotificationSettings`**.

That can produce:

- **Duplicate** notifications / webhooks if the old row was **not** removed (delete failed), or  
- **Orphan `webhookmaster`** if the old row **was** removed but **`saveNotificationSettings` returns early** (e.g. **`membershipId == null`** in `CreateNotificationService`) — same pattern as before, but the **delete + recreate** path makes it easier to hit “PD already points at new URL, DB has webhook row, no `notificationsettings`” → **`findUserIdByWebhookUrl` null**.

So: **this PR did not create the orphan pattern by itself**, but **ignoring the delete result on the recreate branch** is a **new inconsistency** that can amplify bad states.

**Fix direction:** If `deleteNotification` returns `status == error`, **do not** run `saveWebhookMaster` / `saveNotificationSettings`; return **`badRequest`** with the delete error payload.

---

### 2. **`deleteWebhookResponse.get(Constants.STATUS)` can NPE** (defensive)

```362:365:c:\Users\ralagana\Documents\webex-bot-service\bots-common\src\main\java\com\ciscospark\webexbot\common\service\NotificationSettingsService.java
                Map<String, String> deleteWebhookResponse = apiService.deleteWebHook(webhookData, false);
                if(deleteWebhookResponse.get(Constants.STATUS).equals("error")) {
```

If any implementation returns a map **without** `status` (or **`APIService`’s default `emptyMap()`**), this **NPEs**. Unlikely for PagerDuty if `PagerDutyAPIService` always sets `status`, but it’s fragile.

---

### 3. **`PagerDutyCommandService` + `authId == 0`**

```275:279:c:\Users\ralagana\Documents\webex-bot-service\bots\pagerduty\src\main\java\com\ciscospark\webexbot\pagerduty\service\PagerDutyAPIService.java
        if (authId == 0) {
            // If authId is not provided in the webhookData, attempt to retrieve it using the notificationId
            LoggingUtil.info(logger, userId, CLASS_NAME, "AuthID not provided in webhook data. Attempting to retrieve using NotificationID: {}", notificationId);
            authId = notificationSettingsService.getAuthIdByNotificationId(notificationId);
        }
```

So **`0` means “use DB auth”** for space cleanup — that’s intentional. It only goes wrong if the stored auth is invalid; then delete returns **error** and local rows stay (no new orphan from that path).

---

## What this PR **improves** (less likely to cause your symptom)

- **401/403 on PD delete** no longer clears local DB while leaving a live PD subscription (or the opposite confusion). That **reduces** one class of PD/DB mismatch.
- **404 on PD delete** still allows local cleanup, which is usually what you want.

---

## Bottom line

- **Most aligned with your earlier issue:** the **update “create” branch** that **drops the `deleteNotification` result** and still **creates new webhook + notification rows** — especially together with **`saveNotificationSettings`’s silent return when `membershipId` is null** — is the main **PR-adjacent** way to land on **webhook URL in `webhookmaster` with no `notificationsettings`** → **“User id not found”**.
- **Recommend:** add a **guard** after `deleteNotification` in **`updateNonManualNotification`** (and any similar path), and optionally **null-safe** checks on **`deleteWebhookResponse.get(Constants.STATUS)`**.

I did not find a change in **#622** that would directly break **`findUserIdByWebhookUrl`** besides these **consistency / recreate** paths; the **logging-only** “user id not found” line is still explained by **missing join row**, not by a changed query.

---

**User**

I'd like to try to reproduce this issue, what do you think I should try? Any steps you recommend?

---

**Cursor**


Here are focused ways to reproduce the **“User id not found for webhook URL”** behavior (Kafka sees a path segment, DB has no `notificationsettings` row for that `webhookmaster.webhookUrl`).

---

### 1. **Orphan webhook after “notification create” (membership missing)**

This matches `CreateNotificationService.saveNotificationSettings` returning early when `membershipId` is null, after `webhookmaster` is already inserted.

**Idea:** Trigger the normal “create notification” API flow with a **`spaceId` / `botId` pair that has no bot membership** (bot removed from space, wrong space id, stale microsite session).

**Steps (conceptually):**

1. Add the PagerDuty bot to a space and start creating a notification in the microsite so PD subscription is created (or simulate the same API sequence your UI uses).
2. **Before** the final save completes, remove the bot from that space (or use a tampered request with another space’s id where the bot is not a member).
3. Complete/save so `saveWebhookMaster` runs and `saveNotificationSettings` hits `membershipId == null` and **returns without saving** `NotificationSettings`.
4. Trigger a PagerDuty event so PD POSTs to  
   `{baseUrl}/manage/events/pagerduty/{segment}`  
   with the same segment you stored in `webhookmaster`.

**What to check:** DB has a row in `webhookmaster` for that URL segment, **no** row in `notificationsettings` for that `webhookid`. Logs should show **“User id not found…”** and possibly **“MembershipId not found for spaceID:”** around creation time.

---

### 2. **Update flow after PR #622: delete fails, recreate still runs**

**Idea:** Exercise `updateNonManualNotification` when response `type` is **`create`** while **`deleteNotification` returns error** (e.g. PD delete 401/403 with wrong auth).

**Steps:**

1. Create a valid PagerDuty notification (happy path).
2. From the edit UI, pick an **invalid or expired** PagerDuty auth (or force PD to return 401 on delete via mock/proxy if you have one).
3. Save an update that forces the **delete + recreate** path (`type == "create"` — whatever your product uses for that; may be multi-service / certain bots).
4. Confirm whether the server **still** inserts a new `webhookmaster` / `notificationsettings` even though delete returned error (current bug: return value ignored).

**What to check:** Duplicate or inconsistent rows; or, if delete **succeeded** but `saveNotificationSettings` then bailed (membership), orphan webhook again.

---

### 3. **Exact URL mismatch (no code bug, good control test)**

**Idea:** Prove the lookup is **string equality** on the path segment.

**Steps:**

1. Insert or reuse a `webhookmaster` row with URL segment `abc123`.
2. POST to  
   `/manage/events/pagerduty/abc123`  
   vs  
   `/manage/events/pagerduty/ABC123`  
   or with an extra trailing character / different encoding, depending on your gateway.

**What to check:** Mismatch → `findUserIdByWebhookUrl` null even when “it looks like the same webhook” in the UI.

---

### 4. **PagerDuty-side change (realistic “it stopped suddenly”)**

**Steps:**

1. Create integration as usual; note the callback path segment in DB.
2. In PagerDuty, **regenerate** the webhook subscription / change integration so deliveries use a **new** URL path.
3. Do **not** recreate the notification in Webex.

**What to check:** Events hit the **new** segment; DB still has the **old** segment → not found (or the reverse if only PD changed).

---

### Instrumentation that helps while you try

- Log line: **`Pagerduty Notification webhookUrl:`** — compare to `webhookmaster.webhookUrl` and to `notificationsettings` via `webhookid`.
- Search logs for **`MembershipId not found for spaceID`** and **`Failed to delete webhook from external system`** around edits/deletes.
- SQL (shape only):  
  `webhookmaster` row for logged URL + left join `notificationsettings` on `webhookid` → expect **no** child row when the issue reproduces.

---

### Safety

Use a **dev/staging** PagerDuty service and non-production Webex space; webhook URLs act like **capabilities**—do not paste real ones into tickets or screenshots.

---

**Short priority list:** try **(1)** first (fastest to hit the classic orphan path), then **(4)** for “suddenly stopped,” then **(2)** if you suspect the recent update/delete changes.

---

**User**

How would you go about fixing this? please show me

---

**Cursor**


Implementing fixes: checking constants and the full update flow.




Implementing the update-flow guard, hardening delete response handling, and cleaning up orphaned webhooks when membership is missing during create.




Implementing three changes: guarding the update flow, hardening delete response handling, and removing orphaned webhooks when membership is missing.




Here’s what was implemented and how it addresses the issue.

## 1. **Update flow: do not recreate if delete fails** (`MicrositeController`)

When the integration returns `type == "create"`, the code deletes the old notification, then saves a new webhook + settings. The delete result was ignored, so a failed PagerDuty delete could still create new DB rows and leave things inconsistent.

**Change:** Capture the `Map` from `deleteNotification` and, unless `status` is `success`, return **400** with that map and **do not** parse the create response or call `saveWebhookMaster` / `saveNotificationSettings`.

```1434:1440:c:\Users\ralagana\Documents\webex-bot-service\bots-common\src\main\java\com\ciscospark\webexbot\common\controller\MicrositeController.java
            if (response.get(Constants.TYPE) != null && response.get(Constants.TYPE).equals("create")) {
                Map<String, String> deleteResult = notificationSettingsService.deleteNotification(notificationId, authId);
                if (!Constants.SUCCESS.equals(deleteResult.get(Constants.STATUS))) {
                    return ResponseEntity.badRequest().body(deleteResult);
                }
                JsonNode createNode = objectMapper.readTree(response.get(Constants.MESSAGE));
```

---

## 2. **Safer handling of `deleteWebHook` response** (`NotificationSettingsService`)

Avoid **NPE** when the map is null or has no `status`, and treat **`Constants.ERROR`** as failure (aligned with PagerDuty’s error responses). Log the message with **`Constants.MESSAGE`**.

---

## 3. **No orphan `webhookmaster` when membership is missing** (`CreateNotificationService`)

If `membershipId` is null after `saveWebhookMaster` already ran, the code used to return and leave a **webhook row with no `notificationsettings`** — the pattern behind **“User id not found for webhook URL”**.

**Change:** In that branch, call **`webhookMasterService.deleteWebhookMaster(webhookId)`** before returning, and log a **warn** with `spaceId` and `webhookId`.

---

## Tests

`CreateNotificationServiceTest` membership-not-found cases now **`verify(webhookMasterService).deleteWebhookMaster(1)`**. `CreateNotificationServiceTest` passed with Maven.

---

## What you should tell operators / users

- **Existing** orphan rows are **not** fixed by this code; they still need a one-off DB fix or “delete + recreate notification” in the app after PagerDuty is aligned.
- The **microsite** must send **`authId`** on **`DELETE /deleteNotification`** (already required by #622); the **update “create”** path now **surfaces delete errors** instead of continuing.

---

**Security / logging:** The new warn log uses `spaceId` and numeric `webhookId` (no secrets). No credentials were added to the codebase.

