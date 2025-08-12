// GetResultsRouter.js
// Körning av resultatimport med datumintervall + produktonsdiagnostik.
// Standard: senaste 30 dagar (from = today-30, to = today).
// POST /runGetResults body:
// {
//   "from": "YYYY-MM-DD",          // valfritt
//   "to": "YYYY-MM-DD",            // valfritt
//   "organisationIds": [114, 461], // valfritt
//   "debugSample": true            // valfritt – extra loggar kring events-urvalet
// }

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

// Helpers
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
function resolveRange(body) {
  const def = defaultRange();
  const from = (body?.from && /^\d{4}-\d{2}-\d{2}$/.test(body.from)) ? body.from : def.from;
  const to = (body?.to && /^\d{4}-\d{2}-\d{2}$/.test(body.to)) ? body.to : def.to;
  return { from, to };
}

// GET – standard 30 dagar
router.get('/runGetResults', async (req, res) => {
  const range = defaultRange();
  try {
    const summary = await runGetResults(range, null, false);
    res.json({ ok: true, range, summary });
  } catch (err) {
    console.error('[GetResultsRouter][GET] Fel:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST – valfritt intervall + org-filter + debug
router.post('/runGetResults', async (req, res) => {
  const { from, to } = resolveRange(req.body);
  const organisationIdsFilter = Array.isArray(req.body?.organisationIds)
    ? req.body.organisationIds.filter((x) => Number.isInteger(x))
    : null;
  const debugSample = !!req.body?.debugSample;

  try {
    const summary = await runGetResults({ from, to }, organisationIdsFilter, debugSample);
    res.json({ ok: true, range: { from, to }, summary });
  } catch (err) {
    console.error('[GetResultsRouter][POST] Fel:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function runGetResults(range, organisationIdsFilter, debugSample) {
  console.log('[GetResultsRouter] Startar körning av resultatuppdatering', range);

  // 1) Hämta klubbar med apikey
  let clubsQ = supabase
    .from('clubs')
    .select('organisationid, apikey')
    .not('apikey', 'is', null);
  if (organisationIdsFilter && organisationIdsFilter.length > 0) {
    clubsQ = clubsQ.in('organisationid', organisationIdsFilter);
  }
  const { data: clubs, error: clubError } = await clubsQ;
  if (clubError) throw new Error('Fel vid hämtning av klubbar: ' + clubError.message);

  const organisationIds = clubs.map((c) => c.organisationid);
  console.log('[GetResultsRouter] Klubbar att köra:', organisationIds.join(', ') || '(inga)');

  const summary = [];

  for (const club of clubs) {
    const organisationId = club.organisationid;
    console.log(`[GetResultsRouter] Kör fetchResultsForClub för organisationid=${organisationId}`);
    console.log(`[GetResults] === START club ${organisationId} ===`);

    // Count BEFORE
    const { count: beforeCount, error: countBeforeErr } = await supabase
      .from('results')
      .select('*', { count: 'exact', head: true })
      .eq('clubparticipation', organisationId);
    if (countBeforeErr) {
      console.error('[GetResults] Fel vid count (före):', countBeforeErr.message);
    }

    // Skapa batch
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
      console.error(`[GetResults] Fel vid skapande av batchrun:`, batchError.message);
      summary.push({ organisationId, error: batchError.message });
      continue;
    }
    const batchid = batch.id;

    // 2) Hämta events i intervallet
    const { from, to } = range;
    const { data: eventList, error: eventError } = await supabase
      .from('events')
      .select('eventid, eventdate, readonly')
      .gte('eventdate', from)
      .lte('eventdate', to)
      // VIKTIG FIX: tillåt NULL och allt som inte är 1
      .or('readonly.is.null,readonly.neq.1')
      .order('eventdate', { ascending: true });

    if (eventError) {
      console.error(`[GetResults] Fel vid hämtning av events: ${eventError.message}`);
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
    console.log(
      `[GetResults] ${uniqueEventIds.length} eventid hittades i tabellen events inom ${from}..${to}`
    );

    // === Diagnostik om 0 rader ===
    if (uniqueEventIds.length === 0) {
      // a) total antal events
      const { count: totalEvents } = await supabase
        .from('events')
        .select('*', { count: 'exact', head: true });

      // b) min/max eventdate
      const { data: agg } = await supabase
        .from('events')
        .select('min:eventdate,min(eventdate), max:eventdate,max(eventdate)')
        .limit(1);
      const minDate = agg?.[0]?.min || null;
      const maxDate = agg?.[0]?.max || null;

      // c) hur många i intervallet som är readonly=1
      const { count: readonlyInRange } = await supabase
        .from('events')
        .select('*', { count: 'exact', head: true })
        .gte('eventdate', from)
        .lte('eventdate', to)
        .eq('readonly', 1);

      console.warn(`[GetResults][Diag] events totalt: ${totalEvents ?? 'okänt'}, min(eventdate): ${minDate ?? 'okänt'}, max(eventdate): ${maxDate ?? 'okänt'}`);
      console.warn(`[GetResults][Diag] i spannet ${from}..${to}: readonly=1 count: ${readonlyInRange ?? 'okänt'}`);

      if (debugSample) {
        // d) visa några exempelrader runt intervallet
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

        console.warn('[GetResults][Diag] Exempel före intervallet:', JSON.stringify(before2 ?? [], null, 2));
        console.warn('[GetResults][Diag] Exempel i intervallet:', JSON.stringify(inside5 ?? [], null, 2));
        console.warn('[GetResults][Diag] Exempel efter intervallet:', JSON.stringify(after2 ?? [], null, 2));
      }
    }
    // === Slut diagnostik ===

    let antalOk = 0;
    let antalFel = 0;

    for (const eventId of uniqueEventIds) {
      console.log(`[GetResults] Kör resultatimport för eventid=${eventId}`);
      await insertLogData(supabase, {
        source: 'GetResultsRouter',
        level: 'info',
        organisationid: organisationId,
        eventid: eventId,
        batchid,
        comment: `Import av resultat för eventid=${eventId} (range ${from}..${to})`
      });

      const result = await fetchResultsForEvent({
        organisationId,
        eventId,
        batchid,
        apikey: club.apikey
      });

      if (result && result.success === false) antalFel++;
      else antalOk++;
    }

    // Count AFTER
    const { count: afterCount, error: countAfterErr } = await supabase
      .from('results')
      .select('*', { count: 'exact', head: true })
      .eq('clubparticipation', organisationId);
    if (countAfterErr) {
      console.error('[GetResults] Fel vid count (efter):', countAfterErr.message);
    }

    await supabase.from('batchrun').update({
      status: 'success',
      endtime: new Date().toISOString(),
      numberofrequests: antalOk + antalFel,
      numberoferrors: antalFel,
      numberofrowsafter: afterCount || 0
    }).eq('id', batchid);

    console.log(`[GetResults] === SLUT club ${organisationId} ===`);
    summary.push({
      organisationId,
      dateRange: range,
      requests: antalOk + antalFel,
      errors: antalFel,
      eventsProcessed: uniqueEventIds.length
    });
  }

  return summary;
}

module.exports = router;
