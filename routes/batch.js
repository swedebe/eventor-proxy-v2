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

  // Hantera datum
  const parseDate = (str) => new Date(str + "T00:00:00Z");
  const formatDate = (date) => date.toISOString().slice(0, 10);

  const toDate = req.body.toDate
    ? parseDate(req.body.toDate)
    : new Date();

  const fromDate = req.body.fromDate
    ? parseDate(req.body.fromDate)
    : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  const allRows = [];

  for (
    let start = new Date(fromDate);
    start <= toDate;
    start.setDate(start.getDate() + 30)
  ) {
    const end = new Date(Math.min(
      new Date(start.getTime() + 29 * 24 * 60 * 60 * 1000),
      toDate
    ));

    const fromStr = formatDate(start);
    const toStr = formatDate(end);

    const eventorPath = `events?classificationIds=1,2,3,6&fromDate=${fromStr}&toDate=${toStr}`;
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
        const organiser = event.Organiser;
        const organiserIds = organiser
          ? Array.isArray(organiser.OrganisationId)
            ? organiser.OrganisationId.join(", ")
            : organiser.OrganisationId?.toString() || ""
          : "";

        const races = event.EventRace;
        const raceArray = Array.isArray(races) ? races : races ? [races] : [];

        return raceArray.map(race => ({
          batchid,
          eventid: parseInt(event.EventId),
          eventraceid: parseInt(race.EventRaceId),
          eventdate: race.RaceDate?.Date,
          eventname: event.Name,
          eventorganiser: organiserIds,
          eventdistance: race.WRSInfo?.Distance,
          eventclassificationid: parseInt(event.EventClassificationId)
        }));
      });

      allRows.push(...rows);

      await supabase.from("logdata").update({
        completed: new Date().toISOString(),
        responsecode: `${response.status} ${response.statusText}`
      }).eq("batchid", batchid).eq("request", fullUrl);

    } catch (error) {
      const responsecode = error.response
        ? `${error.response.status} ${error.response.statusText}`
        : "N/A";
      const errormessage = error.message;

      await supabase.from("logdata").update({
        completed: new Date().toISOString(),
        responsecode,
        errormessage
      }).eq("batchid", batchid).eq("request", fullUrl);

      return res.status(500).json({
        error: "Fel vid update-events",
        responsecode,
        errormessage
      });
    }
  }

  // Lägg till alla rader i ett svep
  const { error: upsertError } = await supabase.from("events")
    .upsert(allRows, { onConflict: ["eventraceid"] });

  if (upsertError) {
    return res.status(500).json({
      error: "Fel vid upsert till events",
      errormessage: upsertError.message
    });
  }

  return res.status(200).json({
    message: `Sparade ${allRows.length} tävlingar till Supabase`,
    antal: allRows.length,
    batchid
  });
});

module.exports = router;
