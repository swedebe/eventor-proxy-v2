// GetResultsFetcher.js
// Väljer parser (Standard/MultiDay/Relay), loggar, rensar gamla rader,
// skriver nya rader, och lägger varningar – inkl. varning om clubparticipation-överskrivning.

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const parseResultsStandard = require('./parseResultsStandard.js');
const parseResultsMultiDay = require('./parseResultsMultiDay.js');
const parseResultsRelay = require('./parseResultsRelay.js');
const { insertLogData } = require('./logHelpersGetResults.js');

/**
 * Utility: Normalize a field of organiser ids to an array of clean id strings.
 *
 * Accepts values like "611", "611,123", "611, 123" or arrays of ids.
 * Trims whitespace and filters out empty segments. Keeps order of appearance and de-duplicates.
 *
 * @param {string|array|null|undefined} ids Raw ids from parser
 * @returns {string[]} List of id strings
 */
function normalizeOrganiserIds(ids) {
  if (!ids) return [];
  // If already an array, map to strings and trim
  if (Array.isArray(ids)) {
    const list = [];
    const seen = new Set();
    for (const id of ids) {
      const s = String(id).trim();
      if (s && !seen.has(s)) {
        list.push(s);
        seen.add(s);
      }
    }
    return list;
  }
  // Otherwise split on comma
  const parts = String(ids)
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    if (!seen.has(part)) {
      out.push(part);
      seen.add(part);
    }
  }
  return out;
}

/**
 * Given a list of organiser ids, fetch their club names from the eventorclubs table.
 * Falls back to "Organisation <id>" if no clubname is found for an id.
 *
 * @param {string[]} ids Array of organiser id strings
 * @returns {Promise<Map<string,string>>} Map from id to clubname or fallback string
 */
async function fetchOrganiserNames(ids) {
  const result = new Map();
  if (!ids || ids.length === 0) return result;
  try {
    const { data, error } = await supabase
      .from('eventorclubs')
      .select('organisationid, clubname')
      .in('organisationid', ids);
    if (error) {
      console.error('[GetResultsFetcher] Fel vid hämtning av eventorclubs:', error.message);
    }
    // Build result map
    if (Array.isArray(data)) {
      for (const row of data) {
        const idStr = String(row.organisationid);
        const name = (row.clubname || '').trim();
        if (name) {
          result.set(idStr, name);
        }
      }
    }
  } catch (e) {
    console.error('[GetResultsFetcher] Ovänterat fel vid hämtning av eventorclubs:', e);
  }
  // ensure each id has an entry; fallback to "Organisation <id>"
  for (const id of ids) {
    if (!result.has(id)) {
      result.set(id, `Organisation ${id}`);
    }
  }
  return result;
}

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
      return { success: false };
    }

    if (!parsed || parsed.length === 0) {
      console.log(`${logContext} 0 resultat tolkades från XML`);
      // Ingen data men detta är inte ett fel – returnera success med 0 rader
      return { success: true, insertedRows: 0 };
    }
    console.log(`${logContext} ${parsed.length} resultat tolkades från XML`);

    // 4) Rensa gamla rader för aktuell klubb+event
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

    // 5) Sätt batchid & eventid, och varna om clubparticipation överskrivs
    // Samla samtidigt eventorganiserids för senare namnuppslag
    const collectedOrganiserIds = new Set();
    for (const row of parsed) {
      const originalClubParticipation = row.clubparticipation ?? null;

      row.batchid = batchid;
      row.eventid = eventId;
      row.clubparticipation = organisationId; // påför importerande klubb

      // Samla organiser-id:n från raden för senare namnuppslag
      try {
        const ids = normalizeOrganiserIds(row.eventorganiserids);
        for (const id of ids) {
          collectedOrganiserIds.add(id);
        }
      } catch (_) {
        // ignore parse errors
      }

      if (
        originalClubParticipation != null &&
        originalClubParticipation !== organisationId
      ) {
        const parts = [];
        parts.push(`clubparticipation ändrades ${originalClubParticipation} → ${organisationId}`);
        if (row.personid != null) parts.push(`personid=${row.personid}`);
        if (row.eventraceid != null) parts.push(`eventraceid=${row.eventraceid}`);
        if (row.relayteamname) parts.push(`team=\"${row.relayteamname}\"`);
        if (row.relayleg != null) parts.push(`leg=${row.relayleg}`);
        warningsFromParse.push(parts.join(' | '));
      }
    }

    // Slå upp namn för organiser-id:n och sätt eventorganiser-fältet
    if (collectedOrganiserIds.size > 0) {
      const idList = Array.from(collectedOrganiserIds);
      const nameMap = await fetchOrganiserNames(idList);
      for (const row of parsed) {
        try {
          const ids = normalizeOrganiserIds(row.eventorganiserids);
          if (ids.length === 0) {
            row.eventorganiser = null;
          } else {
            const names = ids.map((id) => nameMap.get(id) || `Organisation ${id}`);
            row.eventorganiser = names.join(', ');
          }
        } catch (_) {
          // leave row.eventorganiser as is if something fails
        }
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

    // returnera en succésignal så att anropande kod kan skilja på lyckade och
    // misslyckade körningar.
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
