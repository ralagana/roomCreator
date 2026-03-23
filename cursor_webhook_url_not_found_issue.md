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
