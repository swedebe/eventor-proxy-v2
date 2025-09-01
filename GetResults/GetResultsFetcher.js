// GetResults/GetResultsFetcher.js
// Väljer parser (Standard/MultiDay/Relay), loggar, rensar gamla rader per
// clubparticipation+eventid (med UNDANTAG readonly=1), skriver nya rader, och
// lägger varningar – utan att skriva över organisation/clubparticipation från XML.
// Denna version behåller ditt arbetssätt (node-fetch + XML-sträng till parser)
// och har robust loggning via logHelpersGetResults.
//
// Viktiga punkter i denna version:
// 1) Skippa rader där eventraceid saknas + logga warning per rad.
// 2) Bevara readonly=1: inkommande rader som krockar med readonly=1 i DB filtreras bort.
// 3) Rensa gamla rader PER clubparticipation+eventid (från XML), inte per importerande klubb.
//    Rensning hoppar över readonly=1.
// 4) Övriga loggförbättringar som ger tydlig orsak.

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const parseResultsStandard = require('./parseResultsStandard.js');
const parseResultsMultiDay = require('./parseResultsMultiDay.js');
const parseResultsRelay = require('./parseResultsRelay.js');

const {
  insertLogData,
  logApiStart,
  logApiEnd,
  logApiError,
  logDbError,
  logInfo
} = require('./logHelpersGetResults.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Kort bekräftelse i logg att vi har en nyckel – bra vid felsökning i Render (trunkerad)
console.log(
  '[GetResultsFetcher] SUPABASE_SERVICE_ROLE_KEY prefix:',
  SUPABASE_SERVICE_ROLE_KEY?.substring(0, 8) || '<saknas>'
);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// === Hjälpare =================================================================

/**
 * Parser-val direkt ur XML-strängen.
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
 * organisationId = importerande klubb (använder vi för loggning/anrop mot Eventor)
 * eventId       = Eventor EventId
 * batchid       = aktuell körnings batch-id (kan vara null i vissa flöden)
 * apikey        = Eventor API-nyckel
 */
async function fetchResultsForEvent({ organisationId, eventId, batchid, apikey }) {
  const logContext = `[GetResults] Organisation ${organisationId} – Event ${eventId}`;

  // 1) Hämta XML från Eventor med robust loggning
  const url = `https://eventor.orientering.se/api/results/organisation?organisationIds=${organisationId}&eventId=${eventId}`;
  console.log(`${logContext} Hämtar resultat från Eventor: ${url}`);

  // Startlogg (skriver started + request)
  const logId = await logApiStart(url, batchid, {
    source: 'Eventor',
    organisationid: organisationId,
    eventid: eventId
  });

  let response;
  let xml = null;

  try {
    response = await fetch(url, {
      headers: { Accept: 'application/xml', ApiKey: apikey }
    });
    xml = await response.text();
  } catch (netErr) {
    console.error(`${logContext} Nätverksfel mot Eventor:`, netErr);
    await logApiError(logId, netErr, undefined, url);
    return { success: false };
  }

  if (!response?.ok) {
    console.error(
      `${logContext} Eventor-svar ej OK (${response.status}). Förhandsinnehåll:`,
      xml?.slice(0, 500) || '<tomt>'
    );
    await logApiError(logId, response.status, undefined, url);
    return { success: false };
  }

  await logApiEnd(logId, 200, 'OK');

  // 2) Välj parser
  const parserKind = chooseParserFromXml(xml);
  console.log(`${logContext} Parser: ${parserKind}`);

  // 3) Kör parser + samla varningar
  let parsed = [];
  let warningsFromParse = [];
  try {
    if (parserKind === 'relay') {
      const out = parseResultsRelay(xml, organisationId);
      if (Array.isArray(out)) {
        parsed = out;
        warningsFromParse = [];
      } else {
        parsed = out?.results || [];
        warningsFromParse = (out?.warnings || []).map((msg) => ({
          message: msg,
          personid: 0
        }));
      }
    } else if (parserKind === 'multiday') {
      const { results, warnings } = parseResultsMultiDay(xml);
      parsed = results || [];
      warningsFromParse = (warnings || []).map((msg) => ({ message: msg, personid: 0 }));
    } else {
      const { results, warnings } = parseResultsStandard(xml);
      parsed = results || [];
      warningsFromParse = (warnings || []).map((msg) => ({ message: msg, personid: 0 }));
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

  // 3a) Skippa rader utan eventraceid (DB kräver NOT NULL + FK)
  try {
    const missingEventRace = parsed.filter((r) => r.eventraceid == null);
    if (missingEventRace.length > 0) {
      const warningRows = missingEventRace.map((r) => {
        const given = r.persongiven ?? '';
        const family = r.personfamily ?? '';
        const leg = r.relayleg != null ? r.relayleg : '';
        const team = r.relayteamname ?? '';
        return {
          organisationid: organisationId,
          eventid: eventId,
          batchid,
          personid: r.personid ?? 0,
          message: `Rad hoppad över: eventraceid saknas. personname given="${given}", family="${family}", team="${team}", leg=${leg}, personid=${r.personid ?? 0}`,
          created: new Date().toISOString()
        };
      });

      const { error: warnErr } = await supabase.from('warnings').insert(warningRows);
      if (warnErr) {
        console.error(`${logContext} Fel vid INSERT warnings (saknat eventraceid):`, warnErr.message);
        await logDbError(
          { organisationid: organisationId, eventid: eventId, batchid },
          warnErr,
          'Fel vid INSERT warnings (saknat eventraceid)'
        );
      }
      const before = parsed.length;
      parsed = parsed.filter((r) => r.eventraceid != null);
      const after = parsed.length;
      console.log(`${logContext} Filtrerade bort ${before - after} rad(er) utan eventraceid`);
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'info',
        comment: `Filtrerade bort ${before - after} rad(er) utan eventraceid`,
        organisationid: organisationId,
        eventid: eventId,
        batchid
      });
    }
  } catch (e) {
    console.warn(`${logContext} Ov. fel vid filtrering/loggning för saknat eventraceid:`, e.message);
    await logDbError(
      { organisationid: organisationId, eventid: eventId, batchid },
      e,
      'Ov. fel vid filtrering saknat eventraceid'
    );
  }

  // Om allt försvann efter filtrering → ingen insert
  if (!parsed || parsed.length === 0) {
    console.log(`${logContext} 0 rader kvar efter filtrering – inga inserts gjordes`);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'info',
      comment: '0 rader kvar efter filtrering – inga inserts gjordes',
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
    return { success: true, insertedRows: 0 };
  }

  // === NYCKEL-DEL 1: Bevara readonly-rader ===================================
  // Hämta readonly=1-rader i DB för eventet och de klubbar som finns i inkommande data.
  // Filtrera bort inkommande rader som krockar med en readonly-rad.
  // Krock-nyckel: clubparticipation|personid|eventraceid|relayleg
  try {
    // Samla alla inkommande klubbar (inkl. null)
    const incomingClubs = new Set(parsed.map((r) => (r.clubparticipation ?? null)));
    const clubsNonNull = Array.from(incomingClubs).filter((v) => v !== null);

    let readonlyRows = [];
    // 1) readonly för icke-null clubparticipation IN (...)
    if (clubsNonNull.length > 0) {
      const { data, error } = await supabase
        .from('results')
        .select('clubparticipation, personid, eventraceid, relayleg')
        .eq('eventid', eventId)
        .in('clubparticipation', clubsNonNull)
        .eq('readonly', 1);
      if (error) {
        console.warn(`${logContext} Kunde inte läsa readonly-resultatrader (IN):`, error.message);
        await logDbError(
          { organisationid: organisationId, eventid: eventId, batchid },
          error,
          'Fel vid SELECT readonly (IN) i results'
        );
      } else if (Array.isArray(data)) {
        readonlyRows = readonlyRows.concat(data);
      }
    }
    // 2) readonly för clubparticipation IS NULL (om inkommande innehåller null)
    if (incomingClubs.has(null)) {
      const { data, error } = await supabase
        .from('results')
        .select('clubparticipation, personid, eventraceid, relayleg')
        .eq('eventid', eventId)
        .is('clubparticipation', null)
        .eq('readonly', 1);
      if (error) {
        console.warn(`${logContext} Kunde inte läsa readonly-resultatrader (IS NULL):`, error.message);
        await logDbError(
          { organisationid: organisationId, eventid: eventId, batchid },
          error,
          'Fel vid SELECT readonly (IS NULL) i results'
        );
      } else if (Array.isArray(data)) {
        readonlyRows = readonlyRows.concat(data);
      }
    }

    if (readonlyRows.length > 0) {
      const skipSet = new Set(
        readonlyRows.map((r) => `${r.clubparticipation ?? 'NULL'}|${r.personid}|${r.eventraceid}|${r.relayleg ?? ''}`)
      );
      const before = parsed.length;
      parsed = parsed.filter((row) => {
        const key = `${row.clubparticipation ?? 'NULL'}|${row.personid}|${row.eventraceid}|${row.relayleg ?? ''}`;
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
    await logDbError(
      { organisationid: organisationId, eventid: eventId, batchid },
      e,
      'Ov. fel vid readonly-filter'
    );
  }

  console.log(`${logContext} ${parsed.length} resultat efter filtrering`);

  // === NYCKEL-DEL 2: Rensa gamla rader per clubparticipation+eventid =========
  // För varje inkommande clubparticipation (inkl. null) – ta bort befintliga rader
  // i results för samma eventid och clubparticipation, men lämna readonly=1 orört.
  try {
    const incomingClubs = Array.from(new Set(parsed.map((r) => (r.clubparticipation ?? null))));
    for (const club of incomingClubs) {
      let delQ = supabase.from('results').delete().eq('eventid', eventId).not('readonly', 'eq', 1);
      if (club === null) {
        delQ = delQ.is('clubparticipation', null);
      } else {
        delQ = delQ.eq('clubparticipation', club);
      }
      const { error: delErr } = await delQ;
      if (delErr) {
        console.error(`${logContext} Fel vid delete för clubparticipation=${club}:`, delErr.message);
        await logDbError(
          { organisationid: organisationId, eventid: eventId, batchid },
          delErr,
          `Fel vid DELETE results (clubparticipation=${club === null ? 'NULL' : club})`
        );
      } else {
        await insertLogData(supabase, {
          source: 'GetResultsFetcher',
          level: 'info',
          comment: `Rensade tidigare rader för clubparticipation=${club === null ? 'NULL' : club} (readonly=1 bevarade)`,
          organisationid: organisationId,
          eventid: eventId,
          batchid
        });
      }
    }
  } catch (e) {
    console.error(`${logContext} Ovänterat fel vid delete:`, e);
    await logDbError(
      { organisationid: organisationId, eventid: eventId, batchid },
      e,
      'Ov. fel vid DELETE results'
    );
  }

  // 5) Batch-metadata på raderna + varningar om klubbsiffra
  for (const row of parsed) {
    const originalClubParticipation = row.clubparticipation ?? null;

    // sätt metadata på varje rad
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
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'warn',
        organisationid: organisationId,
        eventid: eventId,
        batchid,
        comment: msg
      });
    }

    if (originalClubParticipation == null) {
      // Mer informativ varning inklusive namn, etapp och tid
      const given = row.persongiven ?? '';
      const family = row.personfamily ?? '';
      const leg = row.relayleg != null ? row.relayleg : '';
      // Omvandla resulttime (sekunder) till HH:MM:SS eller MM:SS
      let timeStr = null;
      if (row.resulttime != null && !Number.isNaN(row.resulttime)) {
        const secs = row.resulttime;
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = Math.floor(secs % 60);
        timeStr =
          h > 0
            ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
            : `${m}:${s.toString().padStart(2, '0')}`;
      }
      const msg = `XML clubparticipation saknas – importerande klubb är ${organisationId}. Raden sparas med null i clubparticipation. personname given="${given}", personname family="${family}", leg=${leg}, time=${timeStr ?? 'null'}`;
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'warn',
        organisationid: organisationId,
        eventid: eventId,
        batchid,
        comment: msg
      });
    }
  }

  // 6) Skriv varningar från parsern (om några)
  try {
    if (Array.isArray(warningsFromParse) && warningsFromParse.length > 0) {
      const warningRows = warningsFromParse.map((w) => ({
        organisationid: organisationId,
        eventid: eventId,
        batchid,
        personid: w.personid ?? 0,
        message: w.message,
        created: new Date().toISOString()
      }));
      const { error: warningsInsertError } = await supabase
        .from('warnings')
        .insert(warningRows);
      if (warningsInsertError) {
        console.error(`${logContext} Fel vid insert av warnings:`, warningsInsertError.message);
        await logDbError(
          { organisationid: organisationId, eventid: eventId, batchid },
          warningsInsertError,
          'Fel vid INSERT warnings'
        );
      }
    }
  } catch (wErr) {
    console.error(`${logContext} Ovänterat fel vid hantering av warnings:`, wErr);
    await logDbError(
      { organisationid: organisationId, eventid: eventId, batchid },
      wErr,
      'Ov. fel vid warnings'
    );
  }

  // 7) Skriv resultat – chunkad insert med DB-fellogg
  // Ta bort transient name fields innan insert i results
  const sanitizedParsed = parsed.map(({ persongiven, personfamily, ...rest }) => rest);
  const chunks = chunkArray(sanitizedParsed, 1000);
  let totalInserted = 0;
  let hadDbError = false;

  for (const [idx, chunk] of chunks.entries()) {
    const { data, error } = await supabase.from('results').insert(chunk);
    if (error) {
      hadDbError = true;
      const msg = `Fel vid insert (chunk ${idx + 1}/${chunks.length}): ${error.message}`;
      console.error(`${logContext} ${msg}`);
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'error',
        errormessage: msg,
        organisationid: organisationId,
        eventid: eventId,
        batchid
      });
      await logDbError(
        { organisationid: organisationId, eventid: eventId, batchid },
        error,
        `Insert chunk ${idx + 1}/${chunks.length}`
      );
      // fortsätt med nästa chunk – vi vill se alla fel
      continue;
    }
    // Supabase kan returnera tom data på insert; räkna ändå chunkets längd
    totalInserted += data?.length ?? chunk.length;
  }

  // 8) Slutlogg – beroende på om DB-fel inträffade
  if (hadDbError) {
    const failMsg = `Import misslyckades – minst ett DB-fel inträffade. Insatta rader: ${totalInserted}. Se tidigare DB_ERROR-loggar för detaljer.`;
    console.error(`${logContext} ${failMsg}`);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      comment: failMsg,
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
  } else {
    console.log(`${logContext} Klart. Insatta rader: ${totalInserted}`);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'info',
      comment: `Resultat importerade (${totalInserted} rader)`,
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
  }

  // Mindre paus för att inte stressa Eventor när flera events körs
  await sleep(300);

  return { success: !hadDbError, insertedRows: totalInserted };
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
    await logDbError(
      { organisationid: organisationId, batchid },
      eventError,
      'Fel vid SELECT events'
    );
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

module.exports = {
  fetchResultsForEvent,
  fetchResultsForClub
};
