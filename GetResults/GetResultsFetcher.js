// GetResults/GetResultsFetcher.js
// Väljer parser (Standard/MultiDay/Relay), loggar, rensar gamla rader,
// skriver nya rader, och lägger varningar – utan att skriva över organisation/clubparticipation.
// Denna version behåller ditt befintliga arbetssätt (node-fetch + XML-sträng till parser)
// men kopplar på robust loggning med responsecode/errormessage via logHelpersGetResults.

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const parseResultsStandard = require('./parseResultsStandard.js');
const parseResultsMultiDay = require('./parseResultsMultiDay.js');
const parseResultsRelay = require('./parseResultsRelay.js');

const {
  insertLogData,     // används för infolistor etc.
  logApiStart,       // ny: start av API-anrop
  logApiEnd,         // ny: slut på API-anrop (sätter completed + responsecode)
  logApiError,       // ny: fel vid API-anrop (sätter completed + responsecode + errormessage)
  logDbError,        // ny: DB-fel (responsecode='DB_ERROR')
  logInfo,
  logWarn,
  logDebug
} = require('./logHelpersGetResults.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Bekräftelse i logg (kort) att vi har en nyckel – bra vid felsökning i Render (trunkerad)
console.log('[GetResultsFetcher] SUPABASE_SERVICE_ROLE_KEY prefix:', SUPABASE_SERVICE_ROLE_KEY?.substring(0, 8) || '<saknas>');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// === Hjälpare =================================================================

/**
 * Parser-val direkt ur XML-strängen (behåller din heuristik).
 * - Relay: om <TeamResult> finns
 * - MultiDay: om eventForm="IndMultiDay" eller <EventForm>IndMultiDay</EventForm>
 * - Standard: annars
 */
function chooseParserFromXml(xml) {
  if (/<TeamResult\b/i.test(xml)) return 'relay';
  const mEventFormAttr = xml.match(/<Event[^>]*\beventForm="([^"]+)"/i);
  if (mEventFormAttr && /IndMultiDay/i.test(mEventFormAttr[1])) return 'multiday';
  if (/<EventForm>\s*IndMultiDay\s*<\/EventForm>/i.test(xml)) return 'multiday';
  return 'standard';
}

/** Dela upp stora arrayer i chunkar för insert */
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// === Kärnflöde per event =====================================================

/**
 * organisationId = importerande klubb
 * eventId       = Eventor EventId
 * batchid       = aktuell körnings batch-id (kan vara null i vissa flöden)
 * apikey        = Eventor API-nyckel
 */
async function fetchResultsForEvent({ organisationId, eventId, batchid, apikey }) {
  const logContext = `[GetResults] Organisation ${organisationId} – Event ${eventId}`;

  // 1) Hämta XML från Eventor med robust loggning
  const url = `https://eventor.orientering.se/api/results/organisation?organisationIds=${organisationId}&eventId=${eventId}`;
  console.log(`${logContext} Hämtar resultat från Eventor: ${url}`);

  // Startlogg (skriver started + request). Vi får ett logId (kan vara null om insert faller)
  const logId = await logApiStart(url, batchid, {
    source: 'Eventor',
    organisationid: organisationId,
    eventid: eventId
  });

  let response;
  let xml = null;

  try {
    response = await fetch(url, {
      headers: { Accept: 'application/xml', ApiKey: apikey },
      // node-fetch v2 har inte native timeout; i Render är nätet stabilt men vi låter det vara utan custom-abort.
    });
    xml = await response.text();
  } catch (netErr) {
    console.error(`${logContext} Nätverksfel mot Eventor:`, netErr);
    await logApiError(logId, netErr, undefined, url); // fyller responsecode=-1 + errormessage
    return { success: false };
  }

  if (!response?.ok) {
    // Logga error med status och kort body-snutt
    console.error(`${logContext} Eventor-svar ej OK (${response.status}). Förhandsinnehåll:`, xml?.slice(0, 500) || '<tomt>');
    await logApiError(logId, response.status, undefined, url); // sätter completed + responsecode
    return { success: false };
  }

  // Allt väl: markera slut på API-anropet (200) och lägg en liten OK-notis i comment
  await logApiEnd(logId, 200, 'OK');

  // 2) Välj parser enligt din befintliga heuristik (XML-sträng in)
  const parserKind = chooseParserFromXml(xml);
  console.log(`${logContext} Parser: ${parserKind}`);

  // 3) Kör parser + samla varningar
  let parsed = [];
  let warningsFromParse = [];
  try {
    if (parserKind === 'relay') {
      // Viktigt: skicka importerande klubb så parsern kan filtrera bort andra klubbar + "vacant"
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
    // Logga som API-fel för att fånga upp felet i logdata med message
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
    // Ingen data är inte fel – men vi loggar en info-rad så det syns i din UI
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'info',
      comment: '0 resultat tolkades från XML',
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
    return { success: true, insertedRows: 0 };
  }

  // 3b) Bevara readonly-rader: filtrera bort inkommande rader som krockar med befintliga readonly=1
  try {
    const { data: readonlyRows, error: readonlyRowsErr } = await supabase
      .from('results')
      .select('personid, eventraceid, relayleg')
      .eq('clubparticipation', organisationId)
      .eq('eventid', eventId)
      .eq('readonly', 1);

    if (readonlyRowsErr) {
      console.warn(`${logContext} Kunde inte läsa readonly-resultatrader:`, readonlyRowsErr.message);
      await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, readonlyRowsErr, 'Fel vid SELECT readonly i results');
    } else if (Array.isArray(readonlyRows) && readonlyRows.length > 0) {
      const skipSet = new Set(
        readonlyRows.map((r) => `${r.personid}|${r.eventraceid}|${r.relayleg ?? ''}`)
      );
      const before = parsed.length;
      parsed = parsed.filter((row) => {
        const key = `${row.personid}|${row.eventraceid}|${row.relayleg ?? ''}`;
        return !skipSet.has(key);
      });
      const filteredOut = before - parsed.length;
      if (filteredOut > 0) {
        console.log(`${logContext} Skippar ${filteredOut} resultat från XML p.g.a. readonly-krock`);
        await insertLogData(supabase, {
          source: 'GetResultsFetcher',
          level: 'info',
          comment: `Skippar ${filteredOut} resultat (readonly-krock)`,
          organisationid: organisationId,
          eventid: eventId,
          batchid
        });
      }
    }
  } catch (e) {
    console.warn(`${logContext} Ovänterat fel vid filtrering av readonly-resultat:`, e.message);
    await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, e, 'Ov. fel vid readonly-filter');
  }

  console.log(`${logContext} ${parsed.length} resultat efter readonly-filtrering`);

  // 4) Rensa gamla rader (utan att röra readonly=1)
  try {
    const { error: delErr } = await supabase
      .from('results')
      .delete()
      .eq('clubparticipation', organisationId)
      .eq('eventid', eventId)
      .not('readonly', 'eq', 1);

    if (delErr) {
      console.error(`${logContext} Fel vid delete av tidigare rader:`, delErr.message);
      await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, delErr, 'Fel vid DELETE results');
      // Vi fortsätter försöka skriva nya rader ändå – delete-fel ska inte dölja importfelet i loggarna
    } else {
      console.log(`${logContext} Tidigare rader rensade (readonly rader sparade)`);
    }
  } catch (e) {
    console.error(`${logContext} Ovänterat fel vid delete:`, e);
    await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, e, 'Ov. fel vid DELETE results');
  }

  // 5) Batch‑metadata på raderna + varningar om klubbsiffra
  for (const row of parsed) {
    const originalClubParticipation = row.clubparticipation ?? null;

    row.batchid = batchid;
    row.eventid = eventId;
    // OBS: vi sätter INTE row.clubparticipation = organisationId; (vi behåller parserns värde)

    if (
      originalClubParticipation != null &&
      originalClubParticipation !== organisationId
    ) {
      const parts = [];
      parts.push(
        `XML clubparticipation (${originalClubParticipation}) ≠ importerande klubb (${organisationId}) – raden sparas med XML-värdet`
      );
      if (row.personid != null) parts.push(`personid=${row.personid}`);
      if (row.eventraceid != null) parts.push(`eventraceid=${row.eventraceid}`);
      if (row.relayteamname) parts.push(`team="${row.relayteamname}"`);
      if (row.relayleg != null) parts.push(`leg=${row.relayleg}`);
      const msg = parts.join(' | ');
      console.warn(`[parseResults][Warning] ${msg}`);
      warningsFromParse.push(msg);
    }

    if (originalClubParticipation == null) {
      const msg = `XML clubparticipation saknas – importerande klubb är ${organisationId}. Raden sparas med null i clubparticipation.`;
      console.warn(`[parseResults][Warning] ${msg}`);
      warningsFromParse.push(msg);
    }
  }

  // 6) Skriv varningar (parserns + våra egna)
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
        await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, warningsInsertError, 'Fel vid INSERT warnings');
      }
    }
  } catch (wErr) {
    console.error(`${logContext} Ovänterat fel vid hantering av warnings:`, wErr);
    await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, wErr, 'Ov. fel vid warnings');
  }

  // 7) Skriv resultat – chunkad insert med DB-fellogg
  const chunks = chunkArray(parsed, 1000);
  let totalInserted = 0;

  for (const [idx, chunk] of chunks.entries()) {
    const { data, error } = await supabase.from('results').insert(chunk);
    if (error) {
      const msg = `Fel vid insert (chunk ${idx + 1}/${chunks.length}): ${error.message}`;
      console.error(`${logContext} ${msg}`);
      // Logga i logdata (API/DB) så det syns i din UI
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'error',
        errormessage: msg,
        organisationid: organisationId,
        eventid: eventId,
        batchid
      });
      await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, error, `Insert chunk ${idx + 1}/${chunks.length}`);
      // fortsätt med nästa chunk – vi vill se alla fel
      continue;
    }
    // Supabase kan returnera tom data på insert; räkna ändå chunkets längd
    totalInserted += data?.length ?? chunk.length;
  }

  console.log(`${logContext} Klart. Insatta rader: ${totalInserted}`);
  await insertLogData(supabase, {
    source: 'GetResultsFetcher',
    level: 'info',
    comment: `Resultat importerade (${totalInserted} rader)`,
    organisationid: organisationId,
    eventid: eventId,
    batchid
  });

  // Mindre paus för att inte stressa Eventor när flera events körs
  await sleep(300);

  return { success: true, insertedRows: totalInserted };
}

// === Klubbloppare ============================================================

/**
 * Hämta eventId från tabellen events och kör fetchResultsForEvent för varje event.
 * Vi hoppar över events.readonly=1 för att skydda manuellt arbete (samma som tidigare).
 */
async function fetchResultsForClub({ organisationId, batchid, apikey }) {
  console.log(`[GetResults] === START club ${organisationId} ===`);

  const { data: events, error: eventError } = await supabase
    .from('events')
    .select('eventid, readonly')
    .not('eventid', 'is', null)
    .order('eventid', { ascending: true });

  if (eventError) {
    console.error(`[GetResults] Fel vid hämtning av events:`, eventError.message);
    await logDbError({ organisationid: organisationId, batchid }, eventError, 'Fel vid SELECT events');
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
    if (ev.readonly === 1) {
      await logInfo({
        source: 'GetResultsFetcher',
        level: 'info',
        organisationid: organisationId,
        eventid: ev.eventid,
        comment: 'Event readonly=1 – hoppar över resultatimport'
      });
      continue;
    }

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
