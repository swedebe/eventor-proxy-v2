const express = require("express");
const axios = require("axios");
const xml2js = require("xml2js");
const router = express.Router();
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const API_KEY = process.env.EVENTOR_API_KEY;
const parser = new xml2js.Parser({ explicitArray: false });

function formatDate(date) {
  return date.toISOString().split("T")[0] + " 00:00:00";
}

router.get("/batch/test-eventor-anrop", async (req, res) => {
  const organisationId = 461;
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - 30);

  const fromDate = formatDate(startDate);
  const toDate = formatDate(today);

  const url = `https://eventor.orientering.se/api/events?organisationIds=${organisationId}&fromDate=${fromDate}&toDate=${toDate}&eventClassificationIds=1,2,3,6`;

  try {
    const eventorResponse = await axios.get(url, {
      headers: { ApiKey: API_KEY, Accept: "application/xml" },
    });

    const result = await parser.parseStringPromise(eventorResponse.data);
    const events = result.EventList?.Event || [];
    console.log("Antal tävlingar att bearbeta:", events.length);
    await supabase.from("testlog").insert({ message: `Antal tävlingar: ${events.length}` });

    for (let i = 0; i < Math.min(3, events.length); i++) {
      const event = events[i];
      const race = Array.isArray(event.EventRace) ? event.EventRace[0] : event.EventRace;
      const organiser = Array.isArray(event.Organiser?.OrganisationId)
        ? event.Organiser.OrganisationId.join(",")
        : event.Organiser?.OrganisationId || "";

      const eventData = {
        eventId: parseInt(event.EventId),
        eventRaceId: parseInt(race.EventRaceId),
        eventDate: race.RaceDate?.Date || null,
        eventName: event.Name || "",
        eventOrganiser: organiser,
        eventDistance: race.WRSInfo?.Distance || "",
        eventClassificationId: parseInt(event.EventClassificationId),
      };

      console.log("Försöker spara:", eventData);

      const { error } = await supabase.from("events").insert(eventData);

      if (error) {
        console.log(`Fel vid insert för race ${eventData.eventRaceId}:`, error);
        await supabase.from("testlog").insert({
          message: `Fel vid insert för race ${eventData.eventRaceId}`,
        });
      }
    }

    res.send("OK – testlog försökt");
  } catch (error) {
    console.error("Fel vid anrop eller parsing:", error.message);
    await supabase.from("testlog").insert({
      message: `Fel vid anrop/parsing: ${error.message}`,
    });
    res.status(500).send("Fel vid anrop eller parsing");
  }
});

module.exports = router;
