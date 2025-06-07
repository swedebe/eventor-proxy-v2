const express = require("express");
const router = express.Router();
const { getEvents, getResultsForEvent } = require("../src/eventorClient");
const {
  saveEventsToSupabase,
  getEventsFromSupabase,
  deleteResultsForEvent,
  getPersonMap,
  saveResultsToSupabase,
  logRequest,
  startBatch,
  endBatch,
} = require("../src/supabaseClient");
const { convertTimeToSeconds, calculatePoints, calculateAge } = require("../src/utils");
const { validateApiKey, formatDate, sleep } = require("../src/helpers");
const { v4: uuidv4 } = require("uuid");

router.post("/update-events", async (req, res) => {
  const { organisationId, fromDate, toDate } = req.body;
  const apiKey = req.headers["x-api-key"];
  if (!validateApiKey(apiKey)) return res.status(401).json({ error: "Unauthorized" });

  const batchid = uuidv4();
  const batchStart = new Date();
  let totalEvents = 0;

  try {
    const blocks = getDateBlocks(fromDate, toDate);
    for (const block of blocks) {
      const { start, end } = block;
      const anrop = `/events?organisationId=${organisationId}&fromDate=${start}&toDate=${end}`;
      const logId = await logRequest(batchid, anrop);

      let response;
      try {
        response = await getEvents(organisationId, start, end);
      } catch (err) {
        if (err.response?.status === 429) {
          await sleep(60000);
          response = await getEvents(organisationId, start, end);
        } else {
          await logRequest(batchid, anrop, err.response?.status, err.message, logId);
          throw err;
        }
      }

      let eventsSaved = 0;
      try {
        eventsSaved = await saveEventsToSupabase(response, batchid);
      } catch (saveErr) {
        await logRequest(batchid, anrop, 500, saveErr.message, logId);
        throw saveErr;
      }

      totalEvents += eventsSaved;
      await logRequest(batchid, anrop, 200, null, logId, true);
    }

    res.json({ message: "Körning slutförd", antal: totalEvents, batchid });
  } catch (err) {
    await endBatch(batchid, "failed", err.message);
    res.status(500).json({ error: "Fel vid uppdatering", errormessage: err.message });
  }
});

router.post("/update-results", async (req, res) => {
  const { organisationId } = req.body;
  const apiKey = req.headers["x-api-key"];
  if (!validateApiKey(apiKey)) return res.status(401).json({ error: "Unauthorized" });

  const batchid = uuidv4();
  await startBatch(batchid, organisationId, "update-results");

  try {
    const personMap = await getPersonMap(organisationId);
    const events = await getEventsFromSupabase();

    for (const event of events) {
      const { eventid, eventdate } = event;
      const anrop = `/results/organisation?organisationIds=${organisationId}&eventId=${eventid}`;
      const logId = await logRequest(batchid, anrop);

      let data;
      try {
        data = await getResultsForEvent(organisationId, eventid);
      } catch (err) {
        if (err.response?.status === 429) {
          await sleep(60000);
          data = await getResultsForEvent(organisationId, eventid);
        } else {
          await logRequest(batchid, anrop, err.response?.status, err.message, logId);
          continue;
        }
      }

      await deleteResultsForEvent(organisationId, eventid);

      const enrichedResults = data.map(result => {
        const person = personMap[result.PersonId] || {};
        const klassfaktor = [16, 17, 19].includes(result.ClassTypeId)
          ? { 16: 125, 17: 100, 19: 75 }[result.ClassTypeId]
          : null;

        const poäng = klassfaktor != null && result.ResultPosition && result.ClassResult_numberOfStarts
          ? calculatePoints(klassfaktor, result.ResultPosition, result.ClassResult_numberOfStarts)
          : null;

        const personålder = person.Person_BirthDate
          ? calculateAge(eventdate, person.Person_BirthDate)
          : null;

        return {
          ...result,
          Klassfaktor: klassfaktor,
          Poäng: poäng,
          Personålder: personålder,
          Person_sex: person.Person_sex || null,
          Result_Time: convertTimeToSeconds(result.Result_Time),
          Result_TimeDiff: convertTimeToSeconds(result.Result_TimeDiff),
          batchid,
        };
      });

      try {
        await saveResultsToSupabase(enrichedResults);
      } catch (err) {
        await logRequest(batchid, anrop, 500, err?.message || "Unknown error", logId);
        throw err;
      }

      await logRequest(batchid, anrop, 200, null, logId, true);
    }

    await endBatch(batchid, "success", "Alla resultat uppdaterade");
    res.json({ message: "Körning slutförd", antal: events.length, batchid });
  } catch (err) {
    await endBatch(batchid, "failed", err.message);
    res.status(500).json({ error: "Fel vid uppdatering", errormessage: err.message });
  }
});

function getDateBlocks(from, to) {
  const result = [];
  const start = new Date(from || new Date(Date.now() - 30 * 86400000));
  const end = new Date(to || new Date());
  let current = new Date(start);

  while (current < end) {
    const next = new Date(Math.min(current.getTime() + 29 * 86400000, end.getTime()));
    result.push({ start: formatDate(current), end: formatDate(next) });
    current = new Date(next.getTime() + 86400000);
  }
  return result;
}

module.exports = router;
