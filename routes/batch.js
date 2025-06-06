const express = require("express");
const { v4: uuidv4 } = require("uuid");
const xml2js = require("xml2js");
const supabase = require("../lib/supabaseClient");
const eventorClient = require("../lib/eventorClient");

const router = express.Router();

router.post("/update-events", async (req, res) => {
  const organisationId = req.body.organisationId;
  if (!organisationId) {
    return res.status(400).json({ error: "organisationId saknas" });
  }

  const batchid = uuidv4();
  const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const toDate = new Date().toISOString().slice(0, 10);

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

    const eventsRaw = parsed.ArrayOfEvent?.Event;
    const flat = Array.isArray(eventsRaw) ? eventsRaw : eventsRaw ? [eventsRaw] : [];

    const debugInfo = {
      antalEventobjekt: flat.length,
      eventIdFörsta: flat[0]?.EventId,
      eventNamnFörsta: flat[0]?.Name,
      eventRaceCountFörsta: Array.isArray(flat[0]?.EventRace)
        ? flat[0].EventRace.length
        : flat[0]?.EventRace ? 1 : 0
    };

    const rows = flat.flatMap(event => {
      const organiser = event.Organiser?.Name;
      const organiserNames = Array.isArray(organiser) ? organiser.join(", ") : organiser || "";

      const races = event.EventRace;
      const raceArray = Array.isArray(races) ? races : races ? [races] : [];

      return raceArray.map(race => ({
        eventid: parseInt(event.EventId),
        eventraceid: parseInt(race.EventRaceId),
        eventdate: race.Start.Date,
        event_name: event.Name,
        event_organiser: organiserNames,
        event_distance: event.EventForm?.Distance,
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
      antal: rows.length,
      debug: debugInfo
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
