const axios = require('axios');

// Replace this with your Webex personal access token
const ACCESS_TOKEN = 'ZWJhNTY1ZDMtZjhlOC00M2Y0LWJmNmEtNzgzMmZjZDU0NWIyNTFiODg0ZGItNjQ1_PE93_41747e53-f6ed-4d26-8361-11b6c1de9b00';

const BASE_URL = 'https://webexapis.com/v1/rooms';

const headers = {
  Authorization: `Bearer ${ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
};

// Sleep helper to pause execution
const sleep = (seconds) => new Promise(resolve => setTimeout(resolve, seconds * 1000));

//function calling the /rooms API for POST request. Rate-limiting is incorporated within.
const createRoom = async (roomTitle) => {
  while (true) {
    try {
      const response = await axios.post(
        BASE_URL,
        { title: roomTitle },
        { headers }
      );
      console.log(`Room created: ${response.data.title}` + `. Room ID: ${response.data.id}`);
      return;
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfter = parseInt(error.response.headers['retry-after'] || '5', 10);
        console.warn(`Rate limit hit. Retrying in ${retryAfter} seconds...`);
        await sleep(retryAfter);
      } else {
        console.error(`Error creating room "${roomTitle}":`, error.response?.data || error.message);
        return;
      }
    }
  }
};

//function to create rooms on loop with a specified room title.
const createMultipleRooms = async (count) => {
  for (let i = 1; i <= count; i++) {
    const roomTitle = `INC00${i} TEST(resolved) Room`;
    await createRoom(roomTitle);
  }
};

createMultipleRooms(1500);
