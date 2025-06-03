const express = require("express");
const axios = require("axios");
const xml2js = require("xml2js");

const router = express.Router();
const parser = new xml2js.Parser({ explicitArray: false });

router.get("/test-eventor-anrop", async (req, res) => {
  const apiKey = process.env.EVENTOR_API_KEY;

  const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0] + " 00:00:00";
  const toDate = new Date()
    .toISOString()
    .split("T")[0] + " 23:59:59";

  const url = `https://eventor.orientering.se/api/events?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}&classificationIds=1,2,3,6&EventStatusId=3`;

  try {
    const response = await axios.get(url, {
      headers: {
        "ApiKey": apiKey,
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "User-Agent": "PostmanRuntime/7.44.0",
      },
      responseType: "text",
    });

    const xmlData = response.data;
    const parsed = await parser.parseStringPromise(xmlData);

    const events = parsed?.ArrayOfEvent?.Event || [];
    const list = Array.isArray(events) ? events : [events];

    console.log("✅ Antal tävlingar:", list.length);
    list.forEach(ev => {
      const id = ev.EventId || "okänd ID";
      const name = ev.Name || "okänt namn";
      const start = ev.StartTime || "okänt datum";
      console.log(`📅 ${id} – ${name} (${start})`);
    });

    res.status(200).send(`Parsed ${list.length} tävlingar – se logg`);
  } catch (error) {
    console.error("❌ Fel vid anrop/parsin
