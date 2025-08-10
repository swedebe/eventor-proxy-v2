// GetPersons/GetPersonsRunner.js
// Runs GetPersons for all clubs at startup or on demand. Includes job protection.
// Job protection strategy:
// 1) In-process flag to avoid concurrent runs within the same instance.
// 2) Database guard using 'batchrun': if a 'GetPersons batch' with status 'running' started within the last 15 minutes exists, skip.
// 3) When starting, it inserts a guard row in batchrun; when done, updates status.
//
// Turn off autorun by setting AUTO_RUN_PERSONS_ON_START=false in environment.

const { createClient } = require('@supabase/supabase-js');
const { fetchAndStorePersons } = require('./GetPersonsFetcher');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

let inProgress = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dbGuardIsActive() {
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('batchrun')
    .select('id, starttime, status, comment')
    .gte('starttime', fifteenMinAgo)
    .ilike('comment', '%GetPersons batch%')
    .order('starttime', { ascending: false })
    .limit(1);

  if (error) {
    console.error('[GetPersonsRunner] dbGuardIsActive error:', error.message);
    return false;
  }
  const row = data && data[0];
  if (!row) return false;
  if (row.status === 'running') return true;
  return false;
}

async function createGuardRow() {
  const id = require('uuid').v4();
  const { error } = await supabase.from('batchrun').insert({
    id,
    clubparticipation: null,
    starttime: new Date().toISOString(),
    status: 'running',
    comment: 'GetPersons batch (startup/batch guard)',
    numberofrequests: null,
    initiatedby: 'auto',
    renderjobid: process.env.RENDER_INSTANCE_ID || null,
    appversion: null,
    numberofrowsbefore: null,
  });
  if (error) {
    console.error('[GetPersonsRunner] createGuardRow error:', error.message);
    return null;
  }
  return id;
}

async function finalizeGuardRow(id, ok, errorsCount) {
  if (!id) return;
  const { error } = await supabase
    .from('batchrun')
    .update({
      endtime: new Date().toISOString(),
      status: ok ? 'success' : (errorsCount > 0 ? 'partial' : 'error'),
      numberoferrors: errorsCount || 0,
    })
    .eq('id', id);
  if (error) {
    console.error('[GetPersonsRunner] finalizeGuardRow error:', error.message);
  }
}

/**
 * Run persons fetch for all clubs.
 * @param {{ pauseMs?: number, onlyTheseOrganisationIds?: number[] }} options 
 * @returns 
 */
async function runGetPersonsForAllClubs(options = {}) {
  if (inProgress) {
    console.warn('[GetPersonsRunner] Skipping run: already in progress.');
    return { success: false, processed: 0, errors: [{ stage: 'guard', error: 'already-in-progress' }] };
  }

  if (await dbGuardIsActive()) {
    console.warn('[GetPersonsRunner] Skipping run: db guard indicates another run is active.');
    return { success: false, processed: 0, errors: [{ stage: 'guard', error: 'db-guard-active' }] };
  }

  inProgress = true;
  const guardId = await createGuardRow();

  const pauseMs = Number.isFinite(options.pauseMs) ? options.pauseMs : 600;
  const onlyList = Array.isArray(options.onlyTheseOrganisationIds) ? options.onlyTheseOrganisationIds : null;

  console.log('[GetPersonsRunner] Loading clubs from Supabase...');
  const query = supabase.from('clubs').select('organisationid, apikey').order('organisationid', { ascending: true });
  const { data: clubs, error } = await query;

  if (error) {
    console.error('[GetPersonsRunner] Could not load clubs:', error.message);
    await finalizeGuardRow(guardId, false, 1);
    inProgress = false;
    return { success: false, processed: 0, errors: [{ stage: 'load-clubs', error: error.message }] };
  }
  if (!clubs || clubs.length === 0) {
    console.warn('[GetPersonsRunner] No clubs found in table "clubs". Nothing to do.');
    await finalizeGuardRow(guardId, true, 0);
    inProgress = false;
    return { success: true, processed: 0, errors: [] };
  }

  const targetClubs = onlyList ? clubs.filter(c => onlyList.includes(Number(c.organisationid))) : clubs;
  console.log(`[GetPersonsRunner] Clubs to process: ${targetClubs.map(c => c.organisationid).join(', ')}`);

  const errors = [];
  let processed = 0;

  for (const c of targetClubs) {
    const orgId = Number(c.organisationid);
    if (!Number.isFinite(orgId)) {
      console.warn('[GetPersonsRunner] Skipping club with invalid organisationid:', c);
      continue;
    }

    console.log(`[GetPersonsRunner] === START organisation ${orgId} ===`);
    try {
      const res = await fetchAndStorePersons(orgId);
      console.log(`[GetPersonsRunner] organisation ${orgId} => inserted=${res.insertedCount} warnings=${res.warnings?.length || 0} batchid=${res.batchid}`);
      processed += 1;
    } catch (e) {
      console.error(`[GetPersonsRunner] organisation ${orgId} FAILED:`, e?.message || e);
      errors.push({ organisationid: orgId, error: e?.message || String(e) });
    }
    console.log(`[GetPersonsRunner] === END organisation ${orgId} ===`);
    await sleep(pauseMs);
  }

  const ok = errors.length === 0;
  await finalizeGuardRow(guardId, ok, errors.length);
  inProgress = false;

  if (ok) console.log('[GetPersonsRunner] Completed for all clubs successfully.');
  else console.warn('[GetPersonsRunner] Completed with errors for some clubs:', errors);

  return { success: ok, processed, errors };
}

module.exports = { runGetPersonsForAllClubs };
