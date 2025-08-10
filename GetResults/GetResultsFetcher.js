// GetResultsFetcher.js
// Väljer parser (Standard/MultiDay/Relay), loggar, rensar gamla rader,
// skriver nya rader, och lägger varningar – utan att skriva över organisation/clubparticipation.

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
 * Enkel heuristik för parser-val direkt ur XML.
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
        headers: { Accept: 'application/xml', ApiKey: apikey },
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
      return { success: false };
    }
    const completed = new Date();

    // Logga API-anropet i logdata (utan httpstatus; med started/completed)
    try {
      await insertLogData(supabase, {
        source: 'Eventor',
        level: response?.ok ? 'info' : 'error',
        request: url,
        started: started.toISOString(),
        completed: completed.toISOString(),
        organisationid: organisationId,
        eventid: eventId,
        batchid
      });
    } catch (e) {
      console.warn(`${logContext} Kunde inte logga API-anropet till logdata: ${e.message}`);
    }

    if (!response?.ok) {
      console.error(`${logContext} Eventor-svar ej OK (${response?.status}). Förhandsinnehåll:`, xml?.slice(0, 500) || '<tomt>');
      return { success: false };
    }

    // 2) Välj parser
    const parserKind = chooseParserFromXml(xml);
    console.log(`${logContext} Parser: ${parserKind}`);

    // 3) Kör parser + samla varningar
    let parsed = [];
    let warningsFromParse = [];
    try {
      if (parserKind === 'relay') {
        // VIKTIGT: skicka med importerande klubb så parsern kan filtrera bort andra klubbar + "vacant"
        const out = parseResultsRelay(xml, organisationId);
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
      return { success: false };
    }

    if (!parsed || parsed.length === 0) {
      console.log(`${logContext} 0 resultat tolkades från XML`);
      // Ingen data men detta är inte ett fel – returnera success med 0 rader
      return { success: true, insertedRows: 0 };
    }
    console.log(`${logContext} ${parsed.length} resultat tolkades från XML`);

    // 4) Rensa gamla rader för aktuell klubb+event
    // Vi utgår från att tidigare körningar skrev rader för importerande klubb under samma event.
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
      } else {
        console.log(`${logContext} Tidigare rader (club=${organisationId}, event=${eventId}) rensade`);
      }
    } catch (e) {
      console.error(`${logContext} Ovänterat fel vid delete:`, e);
    }

    // 5) Sätt batchid & eventid, men skriv INTE över clubparticipation.
    //    Om parsern gett ett annat klubb-id än importerande klubb varnar vi,
    //    men vi låter parserns värde stå kvar.
    for (const row of parsed) {
      const originalClubParticipation = row.clubparticipation ?? null;

      row.batchid = batchid;
      row.eventid = eventId;
      // row.clubparticipation = organisationId;  // <— borttagen överskrivning (medvetet)

      if (
        originalClubParticipation != null &&
        originalClubParticipation !== organisationId
      ) {
        const parts = [];
        parts.push(
          `XML clubparticipation (${originalClubParticipation}) matchar inte importerande klubb (${organisationId}) – raden sparas med XML-värdet`
        );
        if (row.personid != null) parts.push(`personid=${row.personid}`);
        if (row.eventraceid != null) parts.push(`eventraceid=${row.eventraceid}`);
        if (row.relayteamname) parts.push(`team="${row.relayteamname}"`);
        if (row.relayleg != null) parts.push(`leg=${row.relayleg}`);
        const msg = parts.join(' | ');

        // Logga varning i Render-konsolen
        console.warn(`[parseResults][Warning] ${msg}`);

        // Lägg till i varningslistan för senare insert i warnings-tabellen
        warningsFromParse.push(msg);
      }

      if (originalClubParticipation == null) {
        const msg = `XML clubparticipation saknas – importerande klubb är ${organisationId}. Raden sparas med null i clubparticipation.`;
        console.warn(`[parseResults][Warning] ${msg}`);
        warningsFromParse.push(msg);
      }
    }

    // 6) Skriv varningar (parserns + våra nya)
    try {
      if (warningsFromParse.length > 0) {
        for (const w of warningsFromParse) console.warn(`[parseResults][Warning] ${w}`);
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

    // 7) Skriv resultat – chunkad insert
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
      } else {
        totalInserted += data?.length ?? chunk.length;
      }
    }

    console.log(`${logContext} Klart. Insatta rader: ${totalInserted}`);
    // 8) Info-rad i logdata (utan numberofrowsafter/httpstatus)
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'info',
      comment: `Resultat importerade (${totalInserted} rader)`,
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });

    // returnera en succésignal
    return { success: true, insertedRows: totalInserted };
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
    return { success: false };
  }
}

/**
 * Klubbloppare: hämta lista av eventId från tabellen events
 * och kör fetchResultsForEvent för varje eventId.
 */
async function fetchResultsForClub({ organisationId, batchid, apikey }) {
  console.log(`[GetResults] === START club ${organisationId} ===`);

  // Hämta unika eventid (vi kör en gång per eventid)
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
    return { success: false };
  }

  if (!events || events.length === 0) {
    console.log('[GetResults] Inga events hittades att köra');
    console.log(`[GetResults] === SLUT club ${organisationId} ===`);
    return { success: true };
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
  return { success: true };
}

module.exports = { fetchResultsForEvent, fetchResultsForClub };
