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

function parseResults(xml, organisationid, eventid) {
  const output = [];
  const classResults = [].concat(xml?.ResultList?.ClassResult || []);

  for (const classResult of classResults) {
    const className = classResult.EventClass?.[0]?.Name?.[0] || null;
    const classTypeId = parseInt(classResult.EventClass?.[0]?.ClassTypeId?.[0] || 0);
    const klassfaktor = classTypeId === 16 ? 125 : classTypeId === 17 ? 100 : classTypeId === 19 ? 75 : null;
    const antalStartande = parseInt(classResult.$?.numberOfStarts || 0);

    const personResults = [].concat(classResult.PersonResult || []);
    for (const personResult of personResults) {
      const person = personResult.Person?.[0] || {};
      const result = personResult.Result?.[0] || {};
      const personId = parseInt(person.PersonId?.[0] || 0);
      const position = parseInt(result.ResultPosition?.[0] || 0);
      const status = result.CompetitorStatus?.[0]?.$.value || "";
      const time = convertTimeToSeconds(result.Time?.[0]);
      const timeDiff = convertTimeToSeconds(result.TimeDiff?.[0]);
      const age = person.BirthDate?.[0]?.Date?.[0] ? new Date().getFullYear() - parseInt(person.BirthDate[0].Date[0].substring(0, 4)) : null;

      const raceResults = [].concat(personResult.RaceResult || []);
      for (const raceResult of raceResults) {
        const eventraceid = parseInt(raceResult.EventRaceId?.[0] || 0);

        const poäng = klassfaktor && position && antalStartande
          ? parseFloat((klassfaktor * (1 - (position / antalStartande))).toFixed(2))
          : null;

        output.push({
          personid: personId,
          eventid,
          eventraceid,
          eventclassname: className,
          resulttime: time,
          resulttimediff: timeDiff,
          resultposition: position || null,
          resultcompetitorstatus: status,
          classresultnumberofstarts: antalStartande || null,
          classtypeid: classTypeId || null,
          klassfaktor,
          points: poäng,
          personage: age,
          organisationid
        });
      }
    }
  }

  return output;
}

async function fetchResultsForClub(supabase, organisationid, apikey) {
  // Start batch
  const { data: batchStart, error: batchStartError } = await supabase
    .from("batchrun")
    .insert([{ modul: "GetResults", starttid: new Date().toISOString() }])
    .select("id")
    .single();

  const batchId = batchStart?.id || null;
  if (batchStartError) console.log("[GetResults] Fel vid start av batchrun:", batchStartError.message);

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
      const message = error.message || "Okänt fel";
      console.log(`[GetResults] Fel för Event ${eventId}: ${message}`);
      await logEnd(supabase, logId, status, message);
    }
  }

  console.log(`[GetResults] Färdig med klubb ${organisationid}`);

  // Avsluta batch och uppdatera tableupdates
  if (batchId) {
    const { error: batchEndError } = await supabase
      .from("batchrun")
      .update({ sluttid: new Date().toISOString() })
      .eq("id", batchId);

    if (batchEndError) console.log("[GetResults] Fel vid avslut av batchrun:", batchEndError.message);
  }

  const { error: updateError } = await supabase
    .from("tableupdates")
    .update({ lastupdated: new Date().toISOString() })
    .eq("tablename", "results");

  if (updateError) console.log("[GetResults] Fel vid uppdatering av tableupdates:", updateError.message);
}

module.exports = { fetchResultsForClub };
