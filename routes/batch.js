const express = require("express");
const axios = require("axios");
const router = express.Router();

router.get("/test-eventor-anrop", async (req, res) => {
  const organisationId = "461"; // FK Åsen
  const apiKey = process.env.EVENTOR_API_KEY;

  const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 dagar bakåt
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
    });

    console.log("✅ Svar från Eventor:\n", response.data);
    res.status(200).send("OK – data loggad i konsol");
  } catch (error) {
    console.error("❌ Fel vid anrop till Eventor:", error.message);
    res.status(500).send("Fel vid anrop till Eventor");
  }
});

module.exports = router;
