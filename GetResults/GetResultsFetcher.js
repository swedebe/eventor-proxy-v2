// GetResultsFetcher.js
// Kompakt men komplett fetcher som väljer rätt parser (Standard/MultiDay/Relay),
// loggar ordentligt, rensar gamla rader, skriver nya rader, och lägger
// in varningar – inklusive särskild varning om clubparticipation skrivs över.

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const parseResultsStandard = require('./parseResultsStandard.js');
const parseResultsMultiDay = require('./parseResultsMultiDay.js');
const parseResultsRelay = require('./parseResultsRelay.js');
const { insertLogData } = require('./logHelpersGetResults.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// DEBUG: Bekräfta att rätt nyckel används
console.log('[DEBUG] SUPABASE_SERVICE_ROLE_KEY börjar med:', SUPABASE_SERVICE_ROLE_KEY?.substring(0, 8));

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * Robust, enkel heuristik för att välja parser direkt ur XML.
 * - Relay: om <TeamResult> finns
 * - MultiDay: om eventForm="IndMultiDay" eller texten "IndMultiDay" i Event-delen
 * - Standard: annars
 */
function chooseParserFromXml(xml) {
  if (/<TeamResult\b/i.test(xml)) return 'relay';
  const mEventFormAttr = xml.match(/<Event[^>]*\beventForm="([^"]+)"/i);
  if (mEventFormAttr && /IndMultiDay/i.test(mEventFormAttr[1])) return 'multiday';
  if (/<EventForm>\s*IndMultiDay\s*<\/EventForm>/i.test(xml)) return 'multiday';
  return 'standard';
}

/** Hjälp: chunkad insert för stora resultatmängder */
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Huvudfunktion per event.
 * organisationId = importerande klubb
 * eventId = Eventor EventId
 * batchid = aktuell körnings batch-id
 * apikey = Eventor API-nyckel
 */
async function fetchResultsForEvent({ organisationId, eventId, batchid, apikey }) {
  const logContext = `[GetResults] Organisation ${organisationId} – Event ${eventId}`;

  try {
    // 1) Hämta XML från Eventor
    const url = `https://eventor.orientering.se/api/results/organisation?organisationIds=${organisationId}&eventId=${eventId}`;
    console.log(`${logContext} Hämtar resultat från Eventor: ${url}`);

    const started = new Date();
    let response, xml;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/xml',
          ApiKey: apikey
        },
        timeout: 60000
      });
      xml = await response.text();
    } catch (netErr) {
      console.error(`${logContext} Nätverksfel mot Eventor:`, netErr);
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'error',
        errormessage: `Nätverksfel: ${netErr.message}`,
        organisationid: organisationId,
        eventid: eventId,
        batchid
      });
      return;
    }
    const ended = new Date();

    // Logga API-anropet i logdata
    try {
      await insertLogData(supabase, {
        source: 'Eventor',
        level: response?.ok ? 'info' : 'error',
        request: url,
        httpstatus: `${response?.status} ${response?.statusText}`,
        started: started.toISOString(),
        ended: ended.toISOString(),
        organisationid: organisationId,
        eventid: eventId,
        batchid
      });
    } catch (e) {
      console.warn(`${logContext} Kunde inte logga API-anropet till logdata: ${e.message}`);
    }

    if (!response?.ok) {
      console.error(`${logContext} Eventor-svar ej OK (${response?.status}). Förhandsinnehåll:`, xml?.slice(0, 500) || '<tomt>');
      return;
    }

    // 2) Välj parser
    const parserKind = chooseParserFromXml(xml);
    console.log(`${logContext} Parser: ${parserKind}`);

    // 3) Kör parser + samla varningar
    let parsed = [];
    let warningsFromParse = [];
    try {
      if (parserKind === 'relay') {
        // Våra relay-parser returnerar { results, warnings }
        const out = parseResultsRelay(xml);
        if (Array.isArray(out)) {
          parsed = out;
        } else {
          parsed = out?.results || [];
          warningsFromParse = out?.warnings || [];
        }
      } else if (parserKind === 'multiday') {
        const { results, warnings } = parseResultsMultiDay(xml);
        parsed = results || [];
        warningsFromParse = warnings || [];
      } else {
        const { results, warnings } = parseResultsStandard(xml);
        parsed = results || [];
        warningsFromParse = warnings || [];
      }
    } catch (parseErr) {
      console.error(`${logContext} Fel vid parsning:`, parseErr);
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'error',
        errormessage: `Fel vid parsning: ${parseErr.message}`,
        organisationid: organisationId,
        eventid: eventId,
        batchid
      });
      return;
    }

    if (!parsed || parsed.length === 0) {
      console.log(`${logContext} 0 resultat tolkades från XML`);
      return;
    }
    console.log(`${logContext} ${parsed.length} resultat tolkades från XML`);

    // 4) Förbered rader: rensa gamla, sätt batchid/club/event, och bygg varningar vid clubparticipation‑överskrivning
    // Rensa tidigare rader för aktuell klubb+event
    try {
      const { error: delErr } = await supabase
        .from('results')
        .delete()
        .eq('clubparticipation', organisationId)
        .eq('eventid', eventId);
      if (delErr) {
        console.error(`${logContext} Fel vid delete av tidigare rader:`, delErr.message);
        await insertLogData(supabase, {
          source: 'GetResultsFetcher',
          level: 'error',
          errormessage: `Fel vid delete av tidigare rader: ${delErr.message}`,
          organisationid: organisationId,
          eventid: eventId,
          batchid
        });
        // Fortsätt ändå – nyimport kan lyckas även om gamla inte fanns
      } else {
        console.log(`${logContext} Tidigare rader (club=${organisationId}, event=${eventId}) rensade`);
      }
    } catch (e) {
      console.error(`${logContext} Ovänterat fel vid delete:`, e);
    }

    // Sätt batchid & eventid, och varna om clubparticipation överskrivs
    for (const row of parsed) {
      const originalClubParticipation = row.clubparticipation ?? null;

      row.batchid = batchid;
      row.eventid = eventId;
      row.clubparticipation = organisationId; // påför importerande klubb

      if (
        originalClubParticipation != null &&
        originalClubParticipation !== organisationId
      ) {
        // Bygg informativt varningsmeddelande (person, team, leg när det finns)
        const parts = [];
        parts.push(`clubparticipation ändrades ${originalClubParticipation} → ${organisationId}`);
        if (row.personid != null) parts.push(`personid=${row.personid}`);
        if (row.eventraceid != null) parts.push(`eventraceid=${row.eventraceid}`);
        if (row.relayteamname) parts.push(`team="${row.relayteamname}"`);
        if (row.relayleg != null) parts.push(`leg=${row.relayleg}`);

        warningsFromParse.push(parts.join(' | '));
      }
    }

    // 5) Skriv varningar (parserns + våra nya)
    try {
      if (warningsFromParse.length > 0) {
        for (const w of warningsFromParse) {
          console.warn(`[parseResults][Warning] ${w}`);
        }
        const warningRows = warningsFromParse.map((msg) => ({
          organisationid: organisationId,
          eventid: eventId,
          batchid,
          personid: 0,
          message: msg,
          created: new Date().toISOString()
        }));
        const { error: warningsInsertError } = await supabase
          .from('warnings')
          .insert(warningRows);
        if (warningsInsertError) {
          console.error(`${logContext} Fel vid insert av warnings:`, warningsInsertError.message);
          await insertLogData(supabase, {
            source: 'GetResultsFetcher',
            level: 'error',
            errormessage: `Fel vid insert av warnings: ${warningsInsertError.message}`,
            organisationid: organisationId,
            eventid: eventId,
            batchid
          });
        }
      }
    } catch (wErr) {
      console.error(`${logContext} Ovänterat fel vid hantering av warnings:`, wErr);
    }

    // 6) Skriv resultat – chunkad insert
    const chunks = chunkArray(parsed, 1000);
    let totalInserted = 0;
    for (const [idx, chunk] of chunks.entries()) {
      const { data, error } = await supabase.from('results').insert(chunk);
      if (error) {
        console.error(`${logContext} Fel vid insert (chunk ${idx + 1}/${chunks.length}):`, error.message);
        await insertLogData(supabase, {
          source: 'GetResultsFetcher',
          level: 'error',
          errormessage: `Fel vid insert (chunk ${idx + 1}/${chunks.length}): ${error.message}`,
          organisationid: organisationId,
          eventid: eventId,
          batchid
        });
        // Fortsätt med nästa chunk
      } else {
        totalInserted += data?.length ?? chunk.length;
      }
    }

    console.log(`${logContext} Klart. Insatta rader: ${totalInserted}`);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'info',
      comment: `Resultat importerade`,
      organisationid: organisationId,
      eventid: eventId,
      batchid,
      numberofrowsafter: totalInserted
    });
  } catch (e) {
    console.error(`${logContext} Ovänterat fel:`, e);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      errormessage: `Ovänterat fel: ${e.message}`,
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
  }
}

/**
 * Klubbloppare: hämta lista av eventId från tabellen events
 * och kör fetchResultsForEvent för varje eventId.
 */
async function fetchResultsForClub({ organisationId, batchid, apikey }) {
  console.log(`[GetResults] === START club ${organisationId} ===`);

  // Hämta unika eventid (enligt dina regler kör vi en gång per eventid)
  const { data: events, error: eventError } = await supabase
    .from('events')
    .select('eventid')
    .order('eventid', { ascending: true });

  if (eventError) {
    console.error(`[GetResults] Fel vid hämtning av events:`, eventError.message);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      errormessage: `Fel vid hämtning av events: ${eventError.message}`,
      organisationid: organisationId,
      batchid
    });
    console.log(`[GetResults] === SLUT club ${organisationId} (fel) ===`);
    return;
  }

  if (!events || events.length === 0) {
    console.log('[GetResults] Inga events hittades att köra');
    console.log(`[GetResults] === SLUT club ${organisationId} ===`);
    return;
  }

  console.log(`[GetResults] ${events.length} eventid hittades i tabellen events`);

  for (const ev of events) {
    await fetchResultsForEvent({
      organisationId,
      eventId: ev.eventid,
      batchid,
      apikey
    });
  }

  console.log(`[GetResults] === SLUT club ${organisationId} ===`);
}

module.exports = { fetchResultsForEvent, fetchResultsForClub };

