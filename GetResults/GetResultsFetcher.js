const axios = require("axios");
const { parseStringPromise } = require("xml2js");
const { logStart, logEnd } = require("./GetResultsLogger");

function convertTimeToSeconds(timeString) {
  if (!timeString) return null;

  const parts = timeString.split(":").map(p => parseInt(p, 10));
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1]; // MM:SS
  } else if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2]; // HH:MM:SS
  } else {
    return null;
  }
}

function parseResults(xml, organisationid, eventId) {
  const output = [];
  const events = xml.ResultList?.Event || [];

  for (const ev of [].concat(events)) {
    const races = [].concat(ev.Race || []);
    for (const race of races) {
      const eventRaceId = parseInt(race.$?.raceId || 0);
      const classes = [].concat(race.ClassResult || []);
      for (const classResult of classes) {
        const className = classResult.Class?.[0]?.Name?.[0] || null;
        const classTypeId = parseInt(classResult.Class?.[0]?.ClassTypeId?.[0] || 0);
        const klassfaktor = classTypeId === 16 ? 125 : classTypeId === 17 ? 100 : classTypeId === 19 ? 75 : null;

        const personResults = [].concat(classResult.PersonResult || []);
        const antalStartande = personResults.length;

        for (const personResult of personResults) {
          const person = personResult.Person?.[0] || {};
          const result = personResult.Result?.[0] || {};
          const personId = parseInt(person.PersonId?.[0] || 0);
          const position = parseInt(result.Position?.[0] || 0);
          const status = result.CompetitorStatus?.[0]?.$.value || "";
          const time = convertTimeToSeconds(result.Time?.[0]);
          const timeDiff = convertTimeToSeconds(result.TimeDiff?.[0]);

          const poäng = klassfaktor && position && antalStartande
            ? parseFloat((klassfaktor * (1 - (position / antalStartande))).toFixed(2))
            : null;

          output.push({
            personid: personId,
            eventid: eventId,
            eventraceid: eventRaceId,
            eventclassname: className,
            resulttime: time,
            resulttimediff: timeDiff,
            resultposition: position || null,
            resultcompetitorstatus: status,
            classresultnumberofstarts: antalStartande || null,
            classtypeid: classTypeId || null,
            klassfaktor,
            points: poäng,
            personage: null,
            organisationid
          });
        }
      }
    }
  }

  return output;
}

async function fetchResultsForClub(supabase, organisationid, apikey) {
  const { data: events, error: errEvents } = await supabase
    .from("events")
    .select("eventid")
    .order("eventid", { ascending: true });

  if (errEvents) throw new Error("Fel vid hämtning av eventid: " + errEvents.message);

  const uniqueEventIds = [...new Set(events.map(e => e.eventid))];

  for (const eventId of uniqueEventIds) {
    console.log(`[GetResults] Organisation ${organisationid} – Event ${eventId}`);

    const { data: existing, error: errCheck } = await supabase
      .from("results")
      .select("eventraceid")
      .eq("organisationid", organisationid)
      .eq("eventid", eventId)
      .limit(1);

    if (errCheck) {
      console.log(`[GetResults] Fel vid kontroll av befintliga resultat: ${errCheck.message}`);
      continue;
    }

    if (!existing || existing.length === 0) {
      console.log(`[GetResults] Inga tidigare resultat – nyimport.`);
    } else {
      console.log(`[GetResults] Tidigare resultat finns – de tas bort innan uppdatering.`);
    }

    const url = `https://eventor.orientering.se/api/results/organisation?organisationIds=${organisationid}&eventId=${eventId}`;
    const headers = { "ApiKey": apikey, "Accept": "application/xml" };

    const logId = await logStart(supabase, url);

    try {
      const response = await axios.get(url, { headers, timeout: 30000 });
      await logEnd(supabase, logId, response.status, null);

      const xml = await parseStringPromise(response.data);
      const results = parseResults(xml, organisationid, eventId);

      console.log(`[GetResults] ${results.length} resultat hittades i Eventor`);

      await supabase
        .from("results")
        .delete()
        .match({ organisationid, eventid });

      for (let i = 0; i < results.length; i += 500) {
        const chunk = results.slice(i, i + 500);
        await supabase.from("results").insert(chunk);
      }

      console.log(`[GetResults] ${results.length} resultat har lagts in`);
    } catch (error) {
      const status = error.response?.status || "ERR";
      const message = error.stack || error.message || "Okänt fel";
      console.log(`[GetResults] Fel för Event ${eventId}: ${message}`);
      await logEnd(supabase, logId, status, message);
    }
  }

  console.log(`[GetResults] Färdig med klubb ${organisationid}`);
}

module.exports = { fetchResultsForClub };
