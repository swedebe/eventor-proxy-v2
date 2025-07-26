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

async function fetchResultsForEvent({ organisationId, eventId, batchid, apikey }) {
  const logContext = `[GetResults] Organisation ${organisationId} – Event ${eventId}`;
  console.log(`${logContext}`);

  const { data: existingRows, error: existingError } = await supabase
    .from('results')
    .select('personid')
    .eq('clubparticipation', organisationId)
    .eq('eventid', eventId);

  if (existingError) {
    console.error(`${logContext} Fel vid kontroll av befintliga rader:`, existingError);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      errormessage: `Fel vid kontroll av befintliga rader: ${existingError.message}`,
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
        errormessage: `Fel vid delete av tidigare rader: ${deleteError.message}`,
        organisationid: organisationId,
        eventid: eventId,
        batchid
      });
      return;
    }
  } else {
    console.log(`${logContext} Inga tidigare resultat – nyimport.`);
  }

  const response = await fetch(`${process.env.SELF_BASE_URL}/api/eventor/results?eventId=${eventId}&organisationId=${organisationId}`, {
    headers: {
      'x-api-key': apikey
    }
  });

  const xml = await response.text();

  let parsed;
  try {
    const eventformRes = await supabase
      .from('events')
      .select('eventform')
      .eq('eventid', eventId)
      .single();

    const eventform = eventformRes?.data?.eventform || '';

    if (eventform === 'IndMultiDay') {
      parsed = parseResultsMultiDay(xml);
    } else if (eventform === 'RelaySingleDay') {
      parsed = parseResultsRelay(xml);
    } else {
      parsed = parseResultsStandard(xml);
    }
  } catch (parseError) {
    console.error(`${logContext} Fel vid parsning av resultat:`, parseError);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      errormessage: `Fel vid parsning av resultat: ${parseError.message}`,
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
    return;
  }

  if (!parsed || parsed.length === 0) {
    console.log(`${logContext} 0 resultat hittades i Eventor`);
    return;
  } else {
    console.log(`${logContext} ${parsed.length} resultat tolkades från XML`);
  }

  for (const row of parsed) {
    row.batchid = batchid;
    row.clubparticipation = organisationId;
  }

  const { error: insertError } = await supabase.from('results').insert(parsed);
  if (insertError) {
    console.error(`${logContext} FEL vid insert till 'results':`, insertError.message);
    console.error(`${logContext} Första raden i chunk:`, parsed[0]);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      errormessage: `FEL vid insert till results: ${insertError.message}`,
      organisationid: organisationId,
      eventid: eventId,
      batchid
    });
    return;
  }

  const { data: afterRows, error: afterError } = await supabase
    .from('results')
    .select('personid')
    .eq('clubparticipation', organisationId)
    .eq('eventid', eventId);

  const numberOfRowsAfter = afterRows?.length ?? 0;
  if (afterError) {
    console.error(`${logContext} Fel vid räkning efter insert:`, afterError);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      errormessage: `Fel vid räkning efter insert: ${afterError.message}`,
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
      errormessage: `Fel vid uppdatering av batchrun: ${updateBatchError.message}`,
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

async function fetchResultsForClub({ organisationId, batchid, apikey }) {
  console.log(`[GetResults] === START club ${organisationId} ===`);

  const { data: events, error: eventsError } = await supabase
    .from('events')
    .select('eventid, eventform');

  if (eventsError || !events) {
    console.error(`[GetResults] Fel vid hämtning av events: ${eventsError?.message}`);
    await insertLogData(supabase, {
      source: 'GetResultsFetcher',
      level: 'error',
      errormessage: `Fel vid hämtning av events: ${eventsError?.message}`,
      organisationid: organisationId,
      batchid
    });
    return;
  }

  for (const event of events) {
    await fetchResultsForEvent({
      organisationId,
      eventId: event.eventid,
      batchid,
      apikey
    });
  }

  console.log(`[GetResults] === SLUT club ${organisationId} ===`);
}

module.exports = { fetchResultsForEvent, fetchResultsForClub };
