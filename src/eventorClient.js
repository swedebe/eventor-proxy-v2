const axios = require("axios");
const xml2js = require("xml2js");

const parser = new xml2js.Parser({ explicitArray: false });

async function getEvents(organisationId, fromDate, toDate) {
  const url = `https://eventor.orientering.se/api/events?organisationId=${organisationId}&fromDate=${fromDate}&toDate=${toDate}&classificationIds=1,2,3,6`;
  const headers = { apiKey: process.env.EVENTOR_API_KEY };

  const response = await axios.get(url, { headers });
  const parsed = await parser.parseStringPromise(response.data);
  return parsed.Event || [];
}

module.exports = {
  getEvents,
};
