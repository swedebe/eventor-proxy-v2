const axios = require("axios");

const EVENTOR_API_KEY = process.env.EVENTOR_API_KEY;

if (!EVENTOR_API_KEY) {
  throw new Error("EVENTOR_API_KEY måste anges som miljövariabel.");
}

const eventorClient = axios.create({
  baseURL: "https://eventor.orientering.se/api/",
  timeout: 15000,
  headers: {
    ApiKey: EVENTOR_API_KEY,
    Accept: "application/xml"
  }
});

module.exports = eventorClient;
