const axios = require("axios");
const { parseStringPromise } = require("xml2js");
const { logStart, logEnd } = require("./GetResultsLogger");
const { convertTimeToSeconds } = require("../utils/timeParser");

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
            eventclass_name: className,
            result_time: time,
            result_timediff: timeDiff,
            resultposition: position || null,
            result_competitorstatus: status,
            classresult_numberofstarts: antalStartande || null,
            classtypeid: classTypeId || null,
            klassfaktor,
            poäng,
            personålder: null, // räknas i annat steg
            tillhörandeorganisationid: organisationid
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
    const url = `https://eventor.orientering.se/api/results/organisation?organisationIds=${organisationid}&eventId=${eventId}`;
    const headers = { "ApiKey": apikey, "Accept": "application/xml" };

    const logId = await logStart(supabase, url);

    try {
      const response = await axios.get(url, { headers, timeout: 30000 });
      await logEnd(supabase, logId, response.status, null);

      const xml = await parseStringPromise(response.data);
      const results = parseResults(xml, organisationid, eventId);

      await supabase
        .from("results")
        .delete()
        .match({ tillhörandeorganisationid: organisationid, eventid });

      const chunks = [];
      for (let i = 0; i < results.length; i += 500) {
        chunks.push(results.slice(i, i + 500));
      }

      for (const chunk of chunks) {
        await supabase.from("results").insert(chunk);
      }
    } catch (error) {
      const status = error.response?.status || "ERR";
      const message = error.message || "Okänt fel";
      await logEnd(supabase, logId, status, message);
    }
  }
}

module.exports = { fetchResultsForClub };
