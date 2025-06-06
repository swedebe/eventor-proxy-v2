const express = require("express");
const axios = require("axios");
const xml2js = require("xml2js");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();
const parser = new xml2js.Parser({ explicitArray: false });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

router.get("/test-eventor-anrop", async (req, res) => {
  // TEST: Skriv en rad till testlog-tabellen
  await supabase.from("testlog").insert({ message: "Render can write!" });

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

    const events = parsed?.EventList?.Event || [];
    const list = Array.isArray(events) ? events : [events];
    console.log("Antal tävlingar att bearbeta:", list.length);

    let addedCount = 0;
    for (const event of list) {
      const eventId = parseInt(event.EventId);
      const eventName = event.Name || null;
      const eventClassificationId = parseInt(event.EventClassificationId || 0);

      const organisers = event.Organiser
        ? Array.isArray(event.Organiser)
          ? event.Organiser.map(o => o.OrganisationId).join(",")
          : event.Organiser.OrganisationId
        : null;

      const eventRaces = Array.isArray(event.EventRace)
        ? event.EventRace
        : [event.EventRace];

      for (const race of eventRaces) {
        const eventRaceId = parseInt(race.EventRaceId);
        const eventDate = race.RaceDate?.Date || null;
        const distance = race.WRSInfo?.Distance || null;

        const insertPayload = {
          eventId,
          eventRaceId,
          eventDate,
          eventName,
          eventOrganiser: organisers,
          eventDistance: distance,
          eventClassificationId,
        };

        console.log("Försöker spara:", JSON.stringify(insertPayload));

        const { error: insertError } = await supabase
          .from("Events")
          .insert(insertPayload);

        if (insertError) {
          console.error(`Fel vid insert för race ${eventRaceId}:`, insertError.message || insertError);
        } else {
          console.log(`Sparade tävling ${eventRaceId} – ${eventName}`);
          addedCount++;
        }
      }
    }

    res.status(200).send(`Bearbetade ${list.length} tävlingar, ${addedCount} nya sparade.`);
  } catch (error) {
    console.error("Fel vid anrop eller parsing:", error.message);
    res.status(500).send("Fel vid anrop eller parsing");
  }
});

module.exports = router;
