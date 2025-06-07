const express = require("express");
const { v4: uuidv4 } = require("uuid");
const xml2js = require("xml2js");
const supabase = require("../lib/supabaseClient");
const eventorClient = require("../lib/eventorClient");

const router = express.Router();

router.post("/update-events", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Ej behörig" });
  }

  const organisationId = req.body.organisationId;
  if (!organisationId) {
    return res.status(400).json({ error: "organisationId saknas" });
  }

  const batchid = uuidv4();
  const toDate = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const eventorPath = `events?classificationIds=1,2,3,6&fromDate=${fromDate}&toDate=${toDate}`;
  const fullUrl = `https://eventor.orientering.se/api/${eventorPath}`;

  await supabase.from("logdata").insert({
    batchid,
    started: new Date().toISOString(),
    request: fullUrl
  });

  try {
    const response = await eventorClient.get(eventorPath);
    const xml = response.data;

    const parser = new xml2js.Parser({ explicitArray: false });
    const parsed = await parser.parseStringPromise(xml);

    const eventsRaw = parsed.EventList?.Event;
    const flat = Array.isArray(eventsRaw) ? eventsRaw : eventsRaw ? [eventsRaw] : [];

    const rows = flat.flatMap(event => {
      const organiser = event.Organiser?.Name;
      const organiserNames = Array.isArray(organiser) ? organiser.join(", ") : organiser || "";

      const races = event.EventRace;
      const raceArray = Array.isArray(races) ? races : races ? [races] : [];

      return raceArray.map(race => ({
        batchid,
        eventid: parseInt(event.EventId),
        eventraceid: parseInt(race.EventRaceId),
        eventdate: race.RaceDate?.Date,
        eventname: event.Name,
        eventorganiser: organiserNames,
        eventdistance: race.WRSInfo?.Distance,
        eventclassificationid: parseInt(event.EventClassificationId)
      }));
    });

    const { error: upsertError } = await supabase.from("events")
      .upsert(rows, { onConflict: ["eventraceid"] });

    if (upsertError) {
      throw new Error(`Fel vid upsert: ${upsertError.message}`);
    }

    await supabase.from("logdata").update({
      completed: new Date().toISOString(),
      responsecode: `${response.status} ${response.statusText}`
    }).eq("batchid", batchid);

    return res.status(200).json({
      message: `Sparade ${rows.length} tävlingar till Supabase`,
      antal: rows.length
    });

  } catch (error) {
    const responsecode = error.response
      ? `${error.response.status} ${error.response.statusText}`
      : "N/A";

    const errormessage = error.message;

    await supabase.from("logdata").update({
      completed: new Date().toISOString(),
      responsecode,
      errormessage
    }).eq("batchid", batchid);

    return res.status(500).json({
      error: "Fel vid update-events",
      responsecode,
      errormessage
    });
  }
});

module.exports = router;
