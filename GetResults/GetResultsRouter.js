// GetResultsRouter.js
// Result import with date-range filtering, strict date validation, and diagnostics.
// GET  /runGetResults                     -> default last 30 days
// POST /runGetResults {from,to,organisationIds[],debugSample}
// - Validates YYYY-MM-DD and actual calendar dates (e.g., rejects 2025-06-31)
// - Swaps from/to if from > to
// - Filters events by eventdate BETWEEN from..to AND (readonly IS NULL OR readonly <> 1)

const express = require('express');
const router = express.Router();
router.use(express.json());

const { createClient } = require('@supabase/supabase-js');
const { fetchResultsForEvent } = require('./GetResultsFetcher.js');
const { insertLogData } = require('./logHelpersGetResults.js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -------------------- Helpers --------------------

function toYMD(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultRange() {
  const now = new Date();
  const to = toYMD(now);
  const fromDate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 30
  ));
  const from = toYMD(fromDate);
  return { from, to };
}

// Validate strict YYYY-MM-DD and that it is a real calendar date in UTC.
function isValidYmd(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const [Y, M, D] = ymd.split('-').map((s) => parseInt(s, 10));
  // Months 1..12, Days 1..31 initial check
  if (M < 1 || M > 12 || D < 1 || D > 31) return false;
  // Build UTC date and ensure round-trip
  const dt = new Date(Date.UTC(Y, M - 1, D));
  return toYMD(dt) === ymd;
}

// Normalize and validate range from req.body; return {range, errorMessage|null}
function resolveAndValidateRange(body) {
  const def = defaultRange();
  let from = body?.from ?? def.from;
  let to = body?.to ?? def.to;

  // Validate both
  if (!isValidYmd(from)) return { errorMessage: `Invalid 'from' date: ${from}` };
  if (!isValidYmd(to)) return { errorMessage: `Invalid 'to' date: ${to}` };

  // If reversed, swap
  if (from > to) {
    const tmp = from; from = to; to = tmp;
  }
  return { range: { from, to }, errorMessage: null };
}

// -------------------- Routes --------------------

// GET – last 30 days (no body)
router.get('/runGetResults', async (req, res) => {
  const range = defaultRange();
  try {
    const summary = await runGetResults(range, null, false);
    res.json({ ok: true, range, summary });
  } catch (err) {
    console.error('[GetResultsRouter][GET] Error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST – accepts { from, to, organisationIds[], debugSample }
router.post('/runGetResults', async (req, res) => {
  const { range, errorMessage } = resolveAndValidateRange(req.body || {});
  if (errorMessage) {
    return res.status(400).json({ ok: false, error: errorMessage });
  }

  const organisationIdsFilter = Array.isArray(req.body?.organisationIds)
    ? req.body.organisationIds.filter((x) => Number.isInteger(x))
    : null;
  const debugSample = !!req.body?.debugSample;

  try {
    const summary = await runGetResults(range, organisationIdsFilter, debugSample);
    res.json({ ok: true, range, summary });
  } catch (err) {
    console.error('[GetResultsRouter][POST] Error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------- Core runner --------------------

async function runGetResults(range, organisationIdsFilter, debugSample) {
  console.log('[GetResultsRouter] Start result update', range);

  // 1) Clubs with apikey
  let clubsQ = supabase
    .from('clubs')
    .select('organisationid, apikey')
    .not('apikey', 'is', null);
  if (organisationIdsFilter && organisationIdsFilter.length > 0) {
    clubsQ = clubsQ.in('organisationid', organisationIdsFilter);
  }
  const { data: clubs, error: clubError } = await clubsQ;
  if (clubError) throw new Error('Error loading clubs: ' + clubError.message);

  const organisationIds = clubs.map((c) => c.organisationid);
  console.log('[GetResultsRouter] Clubs:', organisationIds.join(', ') || '(none)');

  const summary = [];

  for (const club of clubs) {
    const organisationId = club.organisationid;
    console.log(`[GetResultsRouter] Running for organisationId=${organisationId}`);
    console.log(`[GetResults] === START club ${organisationId} ===`);

    // Count BEFORE
    const { count: beforeCount, error: countBeforeErr } = await supabase
      .from('results')
      .select('*', { count: 'exact', head: true })
      .eq('clubparticipation', organisationId);
    if (countBeforeErr) {
      console.error('[GetResults] Count before error:', countBeforeErr.message);
    }

    // Batchrun start
    const { data: batch, error: batchError } = await supabase
      .from('batchrun')
      .insert({
        clubparticipation: organisationId,
        comment: `GetResults ${range.from}..${range.to}`,
        status: 'started',
        initiatedby: 'manual',
        appversion: 'v1',
        renderjobid: process.env.RENDER_INSTANCE_ID || null,
        starttime: new Date().toISOString(),
        numberofrowsbefore: beforeCount || 0
      })
      .select()
      .single();
    if (batchError) {
      console.error('[GetResults] batchrun start error:', batchError.message);
      summary.push({ organisationId, error: batchError.message });
      continue;
    }
    const batchid = batch.id;

    // 2) Events in range, readonly NULL or !=1
    const { from, to } = range;
    const { data: eventList, error: eventError } = await supabase
      .from('events')
      .select('eventid, eventdate, readonly')
      .gte('eventdate', from)
      .lte('eventdate', to)
      .or('readonly.is.null,readonly.neq.1')
      .order('eventdate', { ascending: true });

    if (eventError) {
      console.error('[GetResults] Events query error:', eventError.message);
      await insertLogData(supabase, {
        source: 'GetResultsRouter',
        level: 'error',
        comment: `Fel vid hämtning av events: ${eventError.message}`,
        organisationid: organisationId,
        batchid
      });
      await supabase.from('batchrun').update({
        status: 'fail',
        endtime: new Date().toISOString(),
        numberofrequests: 0,
        numberoferrors: 1
      }).eq('id', batchid);
      summary.push({ organisationId, error: eventError.message });
      continue;
    }

    const uniqueEventIds = [...new Set((eventList || []).map((e) => e.eventid))];
    console.log(`[GetResults] ${uniqueEventIds.length} events in ${from}..${to}`);

    // Diagnostics if 0 rows
    if (uniqueEventIds.length === 0) {
      const { count: totalEvents } = await supabase
        .from('events')
        .select('*', { count: 'exact', head: true });
      const { data: agg } = await supabase
        .from('events')
        .select('min:eventdate,min(eventdate), max:eventdate,max(eventdate)')
        .limit(1);
      const minDate = agg?.[0]?.min || null;
      const maxDate = agg?.[0]?.max || null;
      const { count: readonlyInRange } = await supabase
        .from('events')
        .select('*', { count: 'exact', head: true })
        .gte('eventdate', from)
        .lte('eventdate', to)
        .eq('readonly', 1);

      console.warn(`[GetResults][Diag] events total: ${totalEvents ?? 'unknown'}, min(eventdate): ${minDate ?? 'unknown'}, max(eventdate): ${maxDate ?? 'unknown'}`);
      console.warn(`[GetResults][Diag] in range ${from}..${to}: readonly=1 count: ${readonlyInRange ?? 'unknown'}`);

      if (debugSample) {
        const { data: before2 } = await supabase
          .from('events')
          .select('eventid,eventdate')
          .lt('eventdate', from)
          .order('eventdate', { ascending: false })
          .limit(2);
        const { data: inside5 } = await supabase
          .from('events')
          .select('eventid,eventdate,readonly')
          .gte('eventdate', from)
          .lte('eventdate', to)
          .order('eventdate', { ascending: true })
          .limit(5);
        const { data: after2 } = await supabase
          .from('events')
          .select('eventid,eventdate')
          .gt('eventdate', to)
          .order('eventdate', { ascending: true })
          .limit(2);

        console.warn('[GetResults][Diag] Examples before:', JSON.stringify(before2 ?? [], null, 2));
        console.warn('[GetResults][Diag] Examples inside:', JSON.stringify(inside5 ?? [], null, 2));
        console.warn('[GetResults][Diag] Examples after:', JSON.stringify(after2 ?? [], null, 2));
      }
    }

    let ok = 0;
    let err = 0;

    for (const eventId of uniqueEventIds) {
      console.log(`[GetResults] Import for eventId=${eventId}`);
      await insertLogData(supabase, {
        source: 'GetResultsRouter',
        level: 'info',
        organisationid: organisationId,
        eventid: eventId,
        batchid,
        comment: `Import of results for eventId=${eventId} (range ${from}..${to})`
      });

      const result = await fetchResultsForEvent({
        organisationId,
        eventId,
        batchid,
        apikey: club.apikey
      });

      if (result && result.success === false) err++;
      else ok++;
    }

    // Count AFTER
    const { count: afterCount, error: countAfterErr } = await supabase
      .from('results')
      .select('*', { count: 'exact', head: true })
      .eq('clubparticipation', organisationId);
    if (countAfterErr) {
      console.error('[GetResults] Count after error:', countAfterErr.message);
    }

    await supabase.from('batchrun').update({
      status: 'success',
      endtime: new Date().toISOString(),
      numberofrequests: ok + err,
      numberoferrors: err,
      numberofrowsafter: afterCount || 0
    }).eq('id', batchid);

    console.log(`[GetResults] === END club ${organisationId} ===`);
    summary.push({
      organisationId,
      dateRange: range,
      requests: ok + err,
      errors: err,
      eventsProcessed: uniqueEventIds.length
    });
  }

  return summary;
}

module.exports = router;
