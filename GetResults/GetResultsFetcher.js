const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const parseResultsStandard = require('./parseResultsStandard.js');
const parseResultsMultiDay = require('./parseResultsMultiDay.js');
const parseResultsRelay = require('./parseResultsRelay.js');
const { insertLogData } = require('./logHelpersGetResults.js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function fetchResultsForEvent({ organisationId, eventId, batchid }) {
  const logContext = `[GetResults] Organisation ${organisationId} – Event ${eventId}`;
  console.log(`${logContext}`);

  const { data: club, error: clubError } = await supabase
    .from('clubs')
    .select('apikey')
    .eq('organisationid', organisationId)
    .maybeSingle();

  if (clubError || !club?.apikey) {
    console.error(`${logContext} Kunde inte hämta API-nyckel`);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      message: 'Kunde inte hämta API-nyckel',
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
    return;
  }

  const { data: existingRows, error: existingError } = await supabase
    .from('results')
    .select('id')
    .eq('clubparticipation', organisationId)
    .eq('eventid', eventId);

  if (existingError) {
    console.error(`${logContext} Fel vid kontroll av befintliga rader:`, existingError);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      message: `Fel vid kontroll av befintliga rader: ${existingError.message}`,
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
    return;
  }

  const numberOfRowsBefore = existingRows.length;
  if (numberOfRowsBefore > 0) {
    console.log(`${logContext} ${numberOfRowsBefore} rader tas bort innan nyimport.`);
    const { error: deleteError } = await supabase
      .from('results')
      .delete()
      .eq('clubparticipation', organisationId)
      .eq('eventid', eventId);

    if (deleteError) {
      console.error(`${logContext} Fel vid delete av tidigare rader:`, deleteError.message);
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'error',
        message: `Fel vid delete av tidigare rader: ${deleteError.message}`,
        organisationid: organisationId,
        eventid: eventId,
        batchid
      });
      return;
    }
  } else {
    console.log(`${logContext} Inga tidigare resultat – nyimport.`);
  }

  const url = `${process.env.SELF_BASE_URL}/api/eventor/results?eventId=${eventId}&organisationId=${organisationId}&apikey=${club.apikey}`;
  const response = await fetch(url);
  const xml = await response.text();

  const { data: eventInfo, error: eventError } = await supabase
    .from('events')
    .select('eventform')
    .eq('eventid', eventId)
    .maybeSingle();

  if (eventError || !eventInfo) {
    console.error(`${logContext} Kunde inte hämta eventform`);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      message: `Kunde inte hämta eventform: ${eventError?.message}`,
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
    return;
  }

  let parsed;
  if (eventInfo.eventform === 'IndMultiDay') {
    parsed = parseResultsMultiDay(xml);
  } else if (eventInfo.eventform === 'RelaySingleDay') {
    parsed = parseResultsRelay(xml);
  } else {
    parsed = parseResultsStandard(xml);
  }

  if (!parsed || parsed.length === 0) {
    console.log(`${logContext} 0 resultat hittades i Eventor`);
    return;
  }

  const seen = new Set();
  const warnings = [];

  for (const row of parsed) {
    const key = `${row.personid}-${row.eventraceid}`;
    if (seen.has(key)) {
      warnings.push({
        clubparticipation: organisationId,
        eventid: eventId,
        eventraceid: row.eventraceid,
        personid: row.personid,
        message: 'Duplicate personid+eventraceid in result set',
        batchid
      });
    } else {
      seen.add(key);
    }
    row.batchid = batchid;
    row.clubparticipation = organisationId;
  }

  if (warnings.length > 0) {
    console.log(`${logContext} ${warnings.length} varningar loggas.`);
    const { error: warnError } = await supabase.from('warnings').insert(warnings);
    if (warnError) {
      console.error(`${logContext} Fel vid insert till 'warnings':`, warnError.message);
      await insertLogData(supabase, {
        source: 'GetResultsFetcher',
        level: 'error',
        message: `Fel vid insert till warnings: ${warnError.message}`,
        organisationid: organisationId,
        eventid: eventId,
        batchid
      });
    }
  }

  const { error: insertError } = await supabase.from('results').insert(parsed);
  if (insertError) {
    console.error(`${logContext} FEL vid insert till 'results':`, insertError.message);
    console.error(`${logContext} Första raden i chunk:`, parsed[0]);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      message: `FEL vid insert till results: ${insertError.message}`,
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
    return;
  }

  const { data: afterRows, error: afterError } = await supabase
    .from('results')
    .select('id')
    .eq('clubparticipation', organisationId)
    .eq('eventid', eventId);

  const numberOfRowsAfter = afterRows?.length ?? 0;
  if (afterError) {
    console.error(`${logContext} Fel vid räkning efter insert:`, afterError.message);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      message: `Fel vid räkning efter insert: ${afterError.message}`,
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
  }

  console.log(`${logContext} ${parsed.length} resultat har lagts in`);

  const { error: updateBatchError } = await supabase
    .from('batchrun')
    .update({
      numberofrowsbefore: numberOfRowsBefore,
      numberofrowsafter: numberOfRowsAfter
    })
    .eq('id', batchid);

  if (updateBatchError) {
    console.error(`${logContext} Fel vid uppdatering av batchrun:`, updateBatchError.message);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      message: `Fel vid uppdatering av batchrun: ${updateBatchError.message}`,
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
  }
}

module.exports = fetchResultsForEvent;
