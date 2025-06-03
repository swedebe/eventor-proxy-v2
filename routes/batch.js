const express = require("express");
const axios = require("axios");
const xml2js = require("xml2js");
const router = express.Router();

const PROXY_BASE_URL = process.env.SELF_BASE_URL || "http://localhost:3000/api";
const parser = new xml2js.Parser({ explicitArray: false });

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

    const url = `${PROXY_BASE_URL}/events?fromDate=${encodeURIComponent(formatDate(from))}&toDate=${encodeURIComponent(formatDate(to))}&classificationIds=1,2,3,6&EventStatusId=3`;

    console.log(`\n📆 Interval: ${formatDate(from)} → ${formatDate(to)}`);
    console.log(`🔗 Anropar via proxy: ${url}`);

    try {
      const { data: xml } = await axios.get(url, {
        headers: { ApiKey: apiKey },
        responseType: "text"
      });

      console.log(`🧾 XML-svar från Eventor:\n${xml?.substring(0, 1000) || "[TOMT SVAR]"}\n---- SLUT PÅ XML ----`);

      const parsed = await parser.parseStringPromise(xml);

      if (!parsed?.Events) {
        console.log("⚠️ parsed.Events saknas i svaret:", parsed);
      }

      const eventsRaw = parsed?.Events?.Event || [];
      const events = Array.isArray(eventsRaw) ? eventsRaw : [eventsRaw];

      console.log(`📊 Totalt antal event innan filtrering: ${events.length}`);

      if (events.length === 0) {
        console.log("🔍 Inga events hittades. Rådata:", parsed?.Events);
      }

      console.log(events.map(e => ({
        eventId: e.EventId,
        name: e.Name,
        classificationId: e.EventClassificationId?.value,
        statusId: e.EventStatusId?.value
      })));

      const relevantEvents = events.filter(e =>
        [1, 2, 3, 6].includes(Number(e.EventClassificationId?.value || -1))
      );

      for (const event of relevantEvents) {
        const eventId = event.EventId;
        const eventName = event.Name;
        const resultUrl = `${PROXY_BASE_URL}/results/organisation?organisationIds=${organisationId}&eventId=${eventId}`;

        console.log(`📥 Hämtar resultat för eventId ${eventId}: ${eventName}`);
        console.log(`🔗 Anropar via proxy: ${resultUrl}`);

        try {
          const { data: resultXml } = await axios.get(resultUrl, {
            headers: { ApiKey: apiKey },
            responseType: "text"
          });

          const parsedResult = await parser.parseStringPromise(resultXml);
          const count = JSON.stringify(parsedResult).length;

          results.push({
            eventId,
            eventName,
            resultCount: count,
            status: "ok"
          });
        } catch (err) {
          console.log(`❌ Fel vid hämtning av resultat för event ${eventId}:`, err?.response?.status, err?.response?.data || err.message);
          errors.push({
            eventId,
            eventName,
            error: err.response?.statusText || err.message,
          });
        }
      }
    } catch (err) {
      console.log("❌ FEL VID ANROP AV EVENTS:", err?.response?.status, err?.response?.data || err.message);
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
