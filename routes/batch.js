const express = require("express");
const axios = require("axios");
const router = express.Router();

const BASE_URL = "https://eventor.orientering.se/api";

// Formaterar datum till "YYYY-MM-DD 00:00:00"
function formatDate(date) {
  return date.toISOString().split("T")[0] + " 00:00:00";
}

router.post("/update-results", async (req, res) => {
  const { organisationId, daysBack = 30 } = req.body;
  if (!organisationId) {
    return res.status(400).json({ error: "Missing organisationId" });
  }

  const apiKey = process.env.EVENTOR_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Missing EVENTOR_API_KEY in environment" });
  }

  const today = new Date();
  const startDate = new Date();
  startDate.setDate(today.getDate() - daysBack);

  const results = [];
  const errors = [];

  for (let offset = 0; offset < daysBack; offset += 5) {
    const from = new Date(startDate);
    from.setDate(startDate.getDate() + offset);

    const to = new Date(from);
    to.setDate(from.getDate() + 4);

    const url = `${BASE_URL}/events?fromDate=${encodeURIComponent(formatDate(from))}&toDate=${encodeURIComponent(formatDate(to))}&EventStatusId=3`;

    try {
      const { data } = await axios.get(url, {
        headers: { ApiKey: apiKey },
      });

      const eventsRaw = data?.Event || [];
      const events = Array.isArray(eventsRaw) ? eventsRaw : [eventsRaw];

      const relevantEvents = events.filter(e =>
        [1, 2, 3, 6].includes(Number(e.EventClassificationId?.value || -1))
      );

      for (const event of relevantEvents) {
        const eventId = event.EventId;
        const eventName = event.Name;
        const resultUrl = `${BASE_URL}/results/organisation?organisationIds=${organisationId}&eventId=${eventId}`;

        try {
          const resultResponse = await axios.get(resultUrl, {
            headers: { ApiKey: apiKey },
          });

          const content = resultResponse.data;
          const count = JSON.stringify(content).length;

          results.push({
            eventId,
            eventName,
            resultCount: count,
            status: "ok"
          });
        } catch (err) {
          errors.push({
            eventId,
            eventName,
            error: err.response?.statusText || err.message,
          });
        }
      }
    } catch (err) {
      errors.push({
        interval: `${from.toISOString()} to ${to.toISOString()}`,
        error: err.response?.statusText || err.message,
      });
    }
  }

  res.json({
    organisationId,
    period: `${formatDate(startDate)} to ${formatDate(today)}`,
    eventsProcessed: results.length,
    results,
    errors,
  });
});

module.exports = router;
