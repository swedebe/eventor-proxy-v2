const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const xml2js = require("xml2js");

const router = express.Router();
const parser = new xml2js.Parser({ explicitArray: false });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const formatDate = (date) => {
  return date.toISOString().split("T")[0] + " 00:00:00";
};

router.get("/test-eventor-anrop", async (req, res) => {
  await supabase.from("testlog").insert({ message: "Render can write!" });
  res.status(200).send("OK – testlog försökt");
});

router.get("/test", async (req, res) => {
  const organisationId = 54; // valfri
  const fromDate = formatDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const toDate = formatDate(new Date());
  const url = `https://eventor.orientering.se/api/events?fromDate=${fromDate}&toDate=${toDate}&classificationIds=1,2,3,6&EventStatusId=3`;

  try {
    const response = await axios.get(url, {
      headers: {
        ApiKey: process.env.EVENTOR_API_KEY,
      },
      responseType: "text",
    });

    const parsed = await parser.parseStringPromise(response.data);
    const events = parsed?.EventList?.Event;

    const list = Array.isArray(events) ? events : [events];
    const subset = list.slice(0, 5); // ✅ begränsa till 5 tävlingar
    console.log("Antal tävlingar att bearbeta:", subset.length);

    let addedCount = 0;
    for (const event of subset) {
      const eventRace = Array.isArray(event.EventRace)
        ? event.EventRace[0]
        : event.EventRace;

      const data = {
        eventId: parseInt(event.EventId),
        eventRaceId: parseInt(eventRace.EventRaceId),
        eventDate: eventRace.RaceDate?.Date || null,
        eventName: event.Name || null,
        eventOrganiser: Array.isArray(event.Organiser?.OrganisationId)
          ? event.Organiser.OrganisationId[0]
          : event.Organiser?.OrganisationId || null,
        eventDistance: eventRace.WRSInfo?.Distance || null,
        eventClassificationId: parseInt(event.EventClassificationId),
      };

      console.log("Försöker spara:", data);

      const { error } = await supabase.from("events").insert(data);
      if (error) {
        console.error(`Fel vid insert för race ${data.eventRaceId}:`, error);
      } else {
        addedCount++;
      }
    }

    res.status(200).send(`✅ Klar. Tillagda: ${addedCount}`);
  } catch (err) {
    console.error("Fel vid anrop/parsing:", err.message);
    res.status(500).send("Något gick fel vid hämtning eller parsing.");
  }
});

module.exports = router;
