// GetResults/GetResultsFetcher.js
// Väljer parser (Standard/MultiDay/Relay), loggar, rensar gamla rader per
// clubparticipation+eventid (med UNDANTAG readonly=1), skriver nya rader, och
// lägger varningar – utan att skriva över organisation/clubparticipation från XML.
// Denna version använder uttrycklig rensning: (readonly IS NULL) samt (readonly = 0/false).
//
// Viktiga punkter:
// 1) Skippa rader där eventraceid saknas + logga warning per rad.
// 2) Bevara readonly=1: inkommande rader som krockar med readonly=1 i DB filtreras bort.
// 3) Rensa gamla rader PER clubparticipation+eventid, men endast där readonly IS NULL eller = 0/false.
// 4) Logga antal rader som rensas per klubb/eventid för spårbarhet.

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

console.log(
  '[GetResultsFetcher] SUPABASE_SERVICE_ROLE_KEY prefix:',
  SUPABASE_SERVICE_ROLE_KEY?.substring(0, 8) || '<saknas>'
);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// Hjälpare
function chooseParserFromXml(xml) {
  if (/<TeamResult\b/i.test(xml)) return 'relay';
  const mEventFormAttr = xml.match(/<Event[^>]*\beventForm="([^"]+)"/i);
  if (mEventFormAttr && /IndMultiDay/i.test(mEventFormAttr[1])) return 'multiday';
  if (/<EventForm>\s*IndMultiDay\s*<\/EventForm>/i.test(xml)) return 'multiday';
  return 'standard';
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

// Rensa tidigare rader för (eventid, clubparticipation) där readonly ≠ 1.
// Viktigt: SQL-NULL måste hanteras explicit → två (ev. tre) deletes.
async function deleteOldRowsForClub({ eventId, club, organisationId, batchid }) {
  const logContext = `[GetResults][DEL] event=${eventId} club=${club === null ? 'NULL' : club}`;
  let totalDeleted = 0;

  // 1) readonly IS NULL
  try {
    let q1 = supabase.from('results').delete().eq('eventid', eventId).is('readonly', null);
    q1 = club === null ? q1.is('clubparticipation', null) : q1.eq('clubparticipation', club);
    const { data: delNullData, error: delNullErr } = await q1.select('id');
    if (delNullErr) {
      console.error(`${logContext} fel vid delete (readonly IS NULL):`, delNullErr.message);
      await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, delNullErr,
        'DELETE results (readonly IS NULL)');
    } else {
      const n = Array.isArray(delNullData) ? delNullData.length : 0;
      totalDeleted += n;
      if (n > 0) {
        await insertLogData(supabase, {
          source: 'GetResultsFetcher',
          level: 'info',
          comment: `Deleted ${n} row(s) where readonly IS NULL`,
          organisationid: organisationId, eventid: eventId, batchid
        });
      }
    }
  } catch (e) {
    console.error(`${logContext} oväntat fel (NULL):`, e);
    await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, e,
      'DELETE results (readonly IS NULL) – exception');
  }

  // 2) readonly = 0 (om kolumn är numerisk/int)
  try {
    let q2 = supabase.from('results').delete().eq('eventid', eventId).eq('readonly', 0);
    q2 = club === null ? q2.is('clubparticipation', null) : q2.eq('clubparticipation', club);
    const { data: delZeroData, error: delZeroErr } = await q2.select('id');
    if (delZeroErr) {
      // Trolig typkrock om kolumnen är boolean → logga info och försök med false i steg 3.
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'info',
        comment: `DELETE readonly=0 gav fel (kan vara boolean-kolumn): ${delZeroErr.message}`,
        organisationid: organisationId, eventid: eventId, batchid
      });
    } else {
      const n = Array.isArray(delZeroData) ? delZeroData.length : 0;
      totalDeleted += n;
      if (n > 0) {
        await insertLogData(supabase, {
          source: 'GetResultsFetcher',
          level: 'info',
          comment: `Deleted ${n} row(s) where readonly = 0`,
          organisationid: organisationId, eventid: eventId, batchid
        });
      }
    }
  } catch (e) {
    await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, e,
      'DELETE results (readonly = 0) – exception');
  }

  // 3) readonly = false (om kolumn är boolean)
  try {
    let q3 = supabase.from('results').delete().eq('eventid', eventId).eq('readonly', false);
    q3 = club === null ? q3.is('clubparticipation', null) : q3.eq('clubparticipation', club);
    const { data: delFalseData, error: delFalseErr } = await q3.select('id');
    if (delFalseErr) {
      // Om kolumnen är numerisk kommer detta sannolikt ge typfel; logga som info.
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'info',
        comment: `DELETE readonly=false gav fel (kan vara numerisk kolumn): ${delFalseErr.message}`,
        organisationid: organisationId, eventid: eventId, batchid
      });
    } else {
      const n = Array.isArray(delFalseData) ? delFalseData.length : 0;
      totalDeleted += n;
      if (n > 0) {
        await insertLogData(supabase, {
          source: 'GetResultsFetcher',
          level: 'info',
          comment: `Deleted ${n} row(s) where readonly = false`,
          organisationid: organisationId, eventid: eventId, batchid
        });
      }
    }
  } catch (e) {
    await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, e,
      'DELETE results (readonly = false) – exception');
  }

  await insertLogData(supabase, {
    source: 'GetResultsFetcher',
    level: 'info',
    comment: `Rensning klar för club=${club === null ? 'NULL' : club}: ${totalDeleted} rad(er) borttagna`,
    organisationid: organisationId, eventid: eventId, batchid
  });

  return totalDeleted;
}

// ---------------------------------------------------------------------------
// Kärnflöde per event
async function fetchResultsForEvent({ organisationId, eventId, batchid, apikey }) {
  const logContext = `[GetResults] Organisation ${organisationId} – Event ${eventId}`;

  // 1) Hämta XML
  const url = `https://eventor.orientering.se/api/results/organisation?organisationIds=${organisationId}&eventId=${eventId}`;
  console.log(`${logContext} Hämtar resultat från Eventor: ${url}`);
  const logId = await logApiStart(url, batchid, {
    source: 'Eventor', organisationid: organisationId, eventid: eventId
  });

  let response, xml = null;
  try {
    response = await fetch(url, { headers: { Accept: 'application/xml', ApiKey: apikey } });
    xml = await response.text();
  } catch (netErr) {
    console.error(`${logContext} Nätverksfel:`, netErr);
    await logApiError(logId, netErr, undefined, url);
    return { success: false };
  }
  if (!response?.ok) {
    console.error(`${logContext} Eventor-svar ej OK (${response.status}).`, xml?.slice(0, 500) || '<tomt>');
    await logApiError(logId, response.status, undefined, url);
    return { success: false };
  }
  await logApiEnd(logId, 200, 'OK');

  // 2) Välj parser
  const parserKind = chooseParserFromXml(xml);
  console.log(`${logContext} Parser: ${parserKind}`);

  // 3) Kör parser
  let parsed = [];
  let warningsFromParse = [];
  try {
    if (parserKind === 'relay') {
      const out = parseResultsRelay(xml, organisationId);
      if (Array.isArray(out)) {
        parsed = out;
      } else {
        parsed = out?.results || [];
        warningsFromParse = (out?.warnings || []).map((msg) => ({ message: msg, personid: 0 }));
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
      source: 'GetResultsFetcher', level: 'error',
      errormessage: `Fel vid parsning: ${parseErr.message}`,
      organisationid: organisationId, eventid: eventId, batchid
    });
    return { success: false };
  }

  if (!parsed || parsed.length === 0) {
    await insertLogData(supabase, {
      source: 'GetResultsFetcher', level: 'info',
      comment: '0 resultat tolkades från XML',
      organisationid: organisationId, eventid: eventId, batchid
    });
    return { success: true, insertedRows: 0 };
  }

  // 3a) Skippa rader utan eventraceid
  try {
    const missingEventRace = parsed.filter((r) => r.eventraceid == null);
    if (missingEventRace.length > 0) {
      const warningRows = missingEventRace.map((r) => {
        const given = r.persongiven ?? '';
        const family = r.personfamily ?? '';
        const leg = r.relayleg != null ? r.relayleg : '';
        const team = r.relayteamname ?? '';
        return {
          organisationid: organisationId, eventid: eventId, batchid,
          personid: r.personid ?? 0,
          message: `Rad hoppad över: eventraceid saknas. given="${given}", family="${family}", team="${team}", leg=${leg}, personid=${r.personid ?? 0}`,
          created: new Date().toISOString()
        };
      });
      const { error: warnErr } = await supabase.from('warnings').insert(warningRows);
      if (warnErr) {
        console.error(`${logContext} Fel vid INSERT warnings (saknat eventraceid):`, warnErr.message);
        await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, warnErr,
          'INSERT warnings (saknat eventraceid)');
      }
      parsed = parsed.filter((r) => r.eventraceid != null);
    }
  } catch (e) {
    await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, e,
      'Filtrering saknat eventraceid – exception');
  }
  if (!parsed || parsed.length === 0) {
    await insertLogData(supabase, {
      source: 'GetResultsFetcher', level: 'info',
      comment: '0 rader kvar efter filtrering – inga inserts',
      organisationid: organisationId, eventid: eventId, batchid
    });
    return { success: true, insertedRows: 0 };
  }

  // 4) Bevara readonly-rader: filtrera bort inkommande som krockar exakt
  try {
    const incomingClubs = new Set(parsed.map((r) => (r.clubparticipation ?? null)));
    const clubsNonNull = Array.from(incomingClubs).filter((v) => v !== null);
    let readonlyRows = [];

    if (clubsNonNull.length > 0) {
      const { data, error } = await supabase
        .from('results')
        .select('clubparticipation, personid, eventraceid, relayleg')
        .eq('eventid', eventId)
        .in('clubparticipation', clubsNonNull)
        .eq('readonly', 1);
      if (!error && Array.isArray(data)) readonlyRows = readonlyRows.concat(data);
    }
    if (incomingClubs.has(null)) {
      const { data, error } = await supabase
        .from('results')
        .select('clubparticipation, personid, eventraceid, relayleg')
        .eq('eventid', eventId)
        .is('clubparticipation', null)
        .eq('readonly', 1);
      if (!error && Array.isArray(data)) readonlyRows = readonlyRows.concat(data);
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
        await insertLogData(supabase, {
          source: 'GetResultsFetcher', level: 'info',
          comment: `Skippar ${filteredOut} resultat (readonly-krock)`,
          organisationid: organisationId, eventid: eventId, batchid
        });
      }
    }
  } catch (e) {
    await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, e,
      'Readonly-filter – exception');
  }

  // 5) Rensa gamla rader per clubparticipation+eventid (readonly ≠ 1)
  try {
    const incomingClubs = Array.from(new Set(parsed.map((r) => (r.clubparticipation ?? null))));
    for (const club of incomingClubs) {
      await deleteOldRowsForClub({ eventId, club, organisationId, batchid });
    }
  } catch (e) {
    await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, e,
      'DELETE-loop – exception');
  }

  // 6) Sätt metadata per rad + diagnostik
  for (const row of parsed) {
    const originalClubParticipation = row.clubparticipation ?? null;
    row.batchid = batchid;
    row.eventid = eventId;

    if (originalClubParticipation != null && originalClubParticipation !== organisationId) {
      await insertLogData(supabase, {
        source: 'GetResultsFetcher', level: 'warn',
        organisationid: organisationId, eventid: eventId, batchid,
        comment: `XML clubparticipation (${originalClubParticipation}) ≠ importerande klubb (${organisationId}) – sparar XML-värdet`
      });
    }
    if (originalClubParticipation == null) {
      await insertLogData(supabase, {
        source: 'GetResultsFetcher', level: 'warn',
        organisationid: organisationId, eventid: eventId, batchid,
        comment: `XML clubparticipation saknas – raden sparas med NULL`
      });
    }
  }

  // 7) Logga parser-varningar
  try {
    if (Array.isArray(warningsFromParse) && warningsFromParse.length > 0) {
      const warningRows = warningsFromParse.map((w) => ({
        organisationid: organisationId, eventid: eventId, batchid,
        personid: w.personid ?? 0, message: w.message, created: new Date().toISOString()
      }));
      const { error: warningsInsertError } = await supabase.from('warnings').insert(warningRows);
      if (warningsInsertError) {
        await logDbError({ organisationid: organisationId, eventid: eventId, batchid },
          warningsInsertError, 'INSERT warnings');
      }
    }
  } catch (wErr) {
    await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, wErr,
      'Warnings-hantering – exception');
  }

  // 8) Insert resultat (chunkat)
  const sanitizedParsed = parsed.map(({ persongiven, personfamily, ...rest }) => rest);
  const chunks = chunkArray(sanitizedParsed, 1000);
  let totalInserted = 0;
  let hadDbError = false;

  for (const [idx, chunk] of chunks.entries()) {
    const { data, error } = await supabase.from('results').insert(chunk);
    if (error) {
      hadDbError = true;
      await insertLogData(supabase, {
        source: 'GetResultsFetcher', level: 'error',
        errormessage: `Fel vid insert (chunk ${idx + 1}/${chunks.length}): ${error.message}`,
        organisationid: organisationId, eventid: eventId, batchid
      });
      await logDbError({ organisationid: organisationId, eventid: eventId, batchid }, error,
        `INSERT chunk ${idx + 1}/${chunks.length}`);
      continue;
    }
    totalInserted += data?.length ?? chunk.length;
  }

  if (hadDbError) {
    await insertLogData(supabase, {
      source: 'GetResultsFetcher', level: 'error',
      comment: `Import misslyckades – DB-fel. Insatta rader: ${totalInserted}`,
      organisationid: organisationId, eventid: eventId, batchid
    });
  } else {
    await insertLogData(supabase, {
      source: 'GetResultsFetcher', level: 'info',
      comment: `Resultat importerade (${totalInserted} rader)`,
      organisationid: organisationId, eventid: eventId, batchid
    });
  }

  await sleep(300);
  return { success: !hadDbError, insertedRows: totalInserted };
}

// ---------------------------------------------------------------------------
// Körning per klubb
async function fetchResultsForClub({ organisationId, batchid, apikey }) {
  console.log(`[GetResults] === START club ${organisationId} ===`);

  const { data: events, error: eventError } = await supabase
    .from('events')
    .select('eventid, readonly')
    .not('eventid', 'is', null)
    .order('eventid', { ascending: true });

  if (eventError) {
    await logDbError({ organisationid: organisationId, batchid }, eventError, 'SELECT events');
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
        source: 'GetResultsFetcher', level: 'info',
        organisationid: organisationId, eventid: ev.eventid,
        comment: 'Event readonly=1 – hoppar över resultatimport'
      });
      continue;
    }
    await fetchResultsForEvent({ organisationId, eventId: ev.eventid, batchid, apikey });
  }

  console.log(`[GetResults] === SLUT club ${organisationId} ===`);
  return { success: true };
}

module.exports = { fetchResultsForEvent, fetchResultsForClub };
