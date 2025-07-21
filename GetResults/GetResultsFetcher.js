
const axios = require("axios");
const { parseStringPromise } = require("xml2js");
const { logStart, logEnd } = require("./GetResultsLogger");

function convertTimeToSeconds(timeString) {
  if (!timeString) return null;
  const parts = timeString.split(":").map(p => parseInt(p, 10));
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function parseResults(xml, organisationid, eventId) {
  const results = [];
  const classResults = [].concat(xml.ResultList?.ClassResult || []);

  for (const classResult of classResults) {
    const eventClass = classResult.EventClass?.[0] || {};
    const className = eventClass.Name?.[0] || null;
    const classTypeId = parseInt(eventClass.ClassTypeId?.[0] || 0);
    const klassfaktor = classTypeId === 16 ? 125 : classTypeId === 17 ? 100 : classTypeId === 19 ? 75 : null;

    const numberOfStarts = parseInt(classResult.$?.numberOfStarts || classResult.numberOfStarts?.[0] || 0);
    const personResults = [].concat(classResult.PersonResult || []);

    for (const personResult of personResults) {
      const person = personResult.Person?.[0] || {};
      const result = personResult.Result?.[0] || {};
      const race = personResult.RaceResult?.[0]?.Result?.[0] || result;

      const personId = parseInt(person.PersonId?.[0] || 0);
      const position = parseInt(race.ResultPosition?.[0] || 0);
      const status = race.CompetitorStatus?.[0]?.$.value || "";
      const time = convertTimeToSeconds(race.Time?.[0]);
      const timeDiff = convertTimeToSeconds(race.TimeDiff?.[0]);
      const raceId = parseInt(personResult.RaceResult?.[0]?.EventRaceId?.[0] || 0);

      if (!raceId) {
        console.log(`[GetResults] Hoppar över personId={personId} – ogiltigt eventraceid`);
        continue;
      }

      const poäng = klassfaktor && position && numberOfStarts
        ? parseFloat((klassfaktor * (1 - (position / numberOfStarts))).toFixed(2))
        : null;

      results.push({
        personid: personId,
        eventid: eventId,
        eventraceid: raceId || null,
        eventclassname: className,
        resulttime: time,
        resulttimediff: timeDiff,
        resultposition: position || null,
        resultcompetitorstatus: status,
        classresultnumberofstarts: numberOfStarts || null,
        classtypeid: classTypeId || null,
        klassfaktor,
        points: poäng,
        personage: null,
        organisationid
      });
    }
  }

  return results;
}

async function fetchResultsForClub(supabase, organisationid, apikey) {
  const batchStart = new Date().toISOString();
  const { data: batchData, error: batchError } = await supabase
    .from("batchrun")
    .insert([{
      tablename: "results",
      starttime: batchStart,
      parameters: organisationid.toString()
    }])
    .select();

  if (batchError) {
    console.log(`[GetResults] Fel vid skapande av batchrun: {batchError.message}`);
  }

  const { data: events, error: errEvents } = await supabase
    .from("events")
    .select("eventid")
    .order("eventid", { ascending: true });

  if (errEvents) throw new Error("Fel vid hämtning av eventid: " + errEvents.message);

  const uniqueEventIds = [...new Set(events.map(e => e.eventid))];
  let totalRows = 0;
  let errorOccurred = false;

  for (const eventId of uniqueEventIds) {
    console.log(`[GetResults] Organisation {organisationid} – Event {eventId}`);

    const { data: existing, error: errCheck } = await supabase
      .from("results")
      .select("eventraceid")
      .eq("organisationid", organisationid)
      .eq("eventid", eventId)
      .limit(1);

    if (errCheck) {
      console.log(`[GetResults] Fel vid kontroll av befintliga resultat: {errCheck.message}`);
      continue;
    }

    console.log(existing && existing.length ? `[GetResults] Tidigare resultat finns – de tas bort.` : `[GetResults] Inga tidigare resultat – nyimport.`);

    const url = `https://eventor.orientering.se/api/results/organisation?organisationIds={organisationid}&eventId={eventId}`;
    const headers = { ApiKey: apikey, Accept: "application/xml" };
    const logId = await logStart(supabase, url);

    try {
      const response = await axios.get(url, { headers, timeout: 30000 });
      await logEnd(supabase, logId, response.status, null);

      const xml = await parseStringPromise(response.data);
      const parsedResults = parseResults(xml, organisationid, eventId);

      console.log(`[GetResults] {parsedResults.length} resultat hittades i Eventor`);

      await supabase
        .from("results")
        .delete()
        .match({ organisationid, eventid: eventId });

      for (let i = 0; i < parsedResults.length; i += 500) {
        const chunk = parsedResults.slice(i, i + 500);
        await supabase.from("results").insert(chunk);
      }

      console.log(`[GetResults] {parsedResults.length} resultat har lagts in`);
      totalRows += parsedResults.length;
    } catch (error) {
      const status = error.response?.status || "ERR";
      const message = error.stack || error.message || "Okänt fel";
      console.log(`[GetResults] Fel för Event {eventId}: {message}`);
      await logEnd(supabase, logId, status, message);
      errorOccurred = true;
    }
  }

  const batchEnd = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("tableupdates")
    .upsert({
      tablename: "results",
      lastupdated: batchEnd,
      rowcount: totalRows,
      status: errorOccurred ? "ERROR" : "OK"
    });

  if (updateError) {
    console.log(`[GetResults] Fel vid upsert i tableupdates: {updateError.message}`);
  }

  console.log(`[GetResults] Färdig med klubb {organisationid}`);
}

module.exports = { fetchResultsForClub };
