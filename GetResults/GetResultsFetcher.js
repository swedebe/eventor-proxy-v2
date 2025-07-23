const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { insertLogData } = require('../shared/logHelpers.js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function fetchResultsForEvent({ organisationId, eventId, batchid }) {
  const logContext = `[GetResults] Organisation ${organisationId} – Event ${eventId}`;
  console.log(`${logContext}`);

  // Hämta event för att ta reda på eventform
  const { data: eventRows, error: eventError } = await supabase
    .from('events')
    .select('eventform')
    .eq('eventid', eventId)
    .limit(1)
    .maybeSingle();

  if (eventError) {
    console.error(`${logContext} Fel vid hämtning av eventform:`, eventError);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      message: `Fel vid hämtning av eventform: ${eventError.message}`,
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
    return;
  }

  const eventform = eventRows?.eventform ?? '';
  let parseResults;

  if (!eventform) {
    parseResults = require('./parseResultsStandard');
  } else if (eventform === 'IndMultiDay') {
    parseResults = require('./parseResultsMultiDay');
  } else if (eventform === 'RelaySingleDay') {
    parseResults = require('./parseResultsRelay');
  } else {
    console.warn(`${logContext} Okänt eventform: ${eventform} – standardparser används`);
    parseResults = require('./parseResultsStandard');
  }

  const { data: existingRows, error: existingError } = await supabase
    .from('results')
    .select('id')
    .eq('organisationid', organisationId)
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
      .eq('organisationid', organisationId)
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

  const response = await fetch(`${process.env.SELF_BASE_URL}/api/eventor/results?eventId=${eventId}&organisationId=${organisationId}`);
  const xml = await response.text();
  const parsed = parseResults(xml);

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
        organisationid: organisationId,
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
    .eq('organisationid', organisationId)
    .eq('eventid', eventId);

  const numberOfRowsAfter = afterRows?.length ?? 0;
  if (afterError) {
    console.error(`${logContext} Fel vid räkning efter insert:`, afterError);
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
    console.error(`${logContext} Fel vid uppdatering av batchrun:`, updateBatchError);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      message: `Fel vid uppdatering av batchrun: ${updateBatchError.message}`,
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
  }

  return {
    numberOfRowsBefore,
    numberOfRowsAfter,
    insertedCount: parsed.length
  };
}

module.exports = fetchResultsForEvent;
