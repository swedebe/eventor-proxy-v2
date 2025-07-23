// Uppdaterad GetResultsFetcher.js med batchid, dubblettvarning, robust felhantering och loggdata

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import parseResults from './parseResults.js';
import { insertLogData } from '../shared/logHelpers.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function fetchResultsForEvent({ organisationId, eventId, batchid }) {
  const logContext = `[GetResults] Organisation ${organisationId} – Event ${eventId}`;
  console.log(`${logContext}`);

  // Kontroll av tidigare rader
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

  // Dubblettvarning per (personid, eventraceid)
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

  return {
    numberOfRowsBefore,
    numberOfRowsAfter,
    insertedCount: parsed.length
  };
}
