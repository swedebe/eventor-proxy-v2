// GetResultsRouter.js
// Körning av resultatimport med datumintervall.
// Standard: senaste 30 dagar (from = today-30, to = today).
// POST /runGetResults kan ta body:
// {
//   "from": "2025-07-01",        // valfritt (YYYY-MM-DD)
//   "to": "2025-07-31",          // valfritt (YYYY-MM-DD)
//   "organisationIds": [114,461] // valfritt – begränsa vilka klubbar som körs
// }

const express = require('express');
const router = express.Router();
router.use(express.json()); // säkerställ att vi kan läsa req.body

const { createClient } = require('@supabase/supabase-js');
const { fetchResultsForEvent } = require('./GetResultsFetcher.js');
const { insertLogData } = require('./logHelpersGetResults.js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Hjälp: formatera Date till YYYY-MM-DD (UTC)
function toYMD(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Hjälp: räkna ut defaultintervall (senaste 30 dagar)
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

// Normalisera och validera intervall från body, annars default 30 dagar
function resolveRange(body) {
  const def = defaultRange();
  const from = (body?.from && /^\d{4}-\d{2}-\d{2}$/.test(body.from)) ? body.from : def.from;
  const to = (body?.to && /^\d{4}-\d{2}-\d{2}$/.test(body.to)) ? body.to : def.to;
  return { from, to };
}

// GET kvar för bakåtkompatibilitet – använder default 30 dagar
router.get('/runGetResults', async (req, res) => {
  const range = defaultRange();
  try {
    const summary = await runGetResults(range, null);
    res.json({ ok: true, range, summary });
  } catch (err) {
    console.error('[GetResultsRouter][GET] Fel:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST med möjlighet att ange intervall och/eller organisationer
router.post('/runGetResults', async (req, res) => {
  const { from, to } = resolveRange(req.body);
  const organisationIdsFilter = Array.isArray(req.body?.organisationIds)
    ? req.body.organisationIds.filter((x) => Number.isInteger(x))
    : null;

  try {
    const summary = await runGetResults({ from, to }, organisationIdsFilter);
    res.json({ ok: true, range: { from, to }, summary });
  } catch (err) {
    console.error('[GetResultsRouter][POST] Fel:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function runGetResults(range, organisationIdsFilter) {
  console.log('[GetResultsRouter] Startar körning av resultatuppdatering', range);

  // 1) Hämta klubbar som har apikey, ev. filtrerade
  let clubsQ = supabase
    .from('clubs')
    .select('organisationid, apikey')
    .not('apikey', 'is', null);

  if (organisationIdsFilter && organisationIdsFilter.length > 0) {
    clubsQ = clubsQ.in('organisationid', organisationIdsFilter);
  }

  const { data: clubs, error: clubError } = await clubsQ;
  if (clubError) {
    console.error('[GetResultsRouter] Fel vid hämtning av klubbar:', clubError.message);
    throw new Error('Fel vid hämtning av klubbar');
  }

  const organisationIds = clubs.map((c) => c.organisationid);
  console.log('[GetResultsRouter] Klubbar att köra:', organisationIds.join(', ') || '(inga)');

  const summary = [];

  // 2) Kör klubb för klubb
  for (const club of clubs) {
    const organisationId = club.organisationid;
    console.log(`[GetResultsRouter] Kör fetchResultsForClub för organisationid=${organisationId}`);
    console.log(`[GetResults] === START club ${organisationId} ===`);

    // Count BEFORE (för denna klubb)
    const { count: beforeCount, error: countBeforeErr } = await supabase
      .from('results')
      .select('*', { count: 'exact', head: true })
      .eq('clubparticipation', organisationId);
    if (countBeforeErr) {
      console.error('[GetResults] Fel vid count (före):', countBeforeErr.message);
    }

    // Skapa batchrun
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

    // 3) Hämta event inom datumintervall och inte readonly
    const { from, to } = range;
    const { data: eventList, error: eventError } = await supabase
      .from('events')
      .select('eventid, eventdate')
      .not('readonly', 'eq', 1)
      .gte('eventdate', from)
      .lte('eventdate', to)
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
      // Markera batch som fail för denna klubb
      await supabase
        .from('batchrun')
        .update({
          status: 'fail',
          endtime: new Date().toISOString(),
          numberofrequests: 0,
          numberoferrors: 1
        })
        .eq('id', batchid);
      summary.push({ organisationId, error: eventError.message });
      continue;
    }

    const uniqueEventIds = [...new Set((eventList || []).map((e) => e.eventid))];
    console.log(
      `[GetResults] ${uniqueEventIds.length} eventid hittades i tabellen events inom ${from}..${to}`
    );

    let antalOk = 0;
    let antalFel = 0;

    for (const eventId of uniqueEventIds) {
      console.log(`[GetResults] Kör resultatimport för eventid=${eventId}`);

      try {
        await insertLogData(supabase, {
          source: 'GetResultsRouter',
          level: 'info',
          organisationid: organisationId,
          eventid: eventId,
          batchid,
          comment: `Import av resultat för eventid=${eventId} (range ${from}..${to})`
        });
      } catch (err) {
        await insertLogData(supabase, {
          source: 'GetResultsRouter',
          level: 'error',
          organisationid: organisationId,
          eventid: eventId,
          batchid,
          errormessage: `Fel vid loggning av resultatimport: ${err.message}`
        });
      }

      const result = await fetchResultsForEvent({
        organisationId,
        eventId,
        batchid,
        apikey: club.apikey
      });

      if (result && result.success === false) {
        antalFel++;
      } else {
        antalOk++;
      }
    }

    // Count AFTER
    const { count: afterCount, error: countAfterErr } = await supabase
      .from('results')
      .select('*', { count: 'exact', head: true })
      .eq('clubparticipation', organisationId);
    if (countAfterErr) {
      console.error('[GetResults] Fel vid count (efter):', countAfterErr.message);
    }

    // Uppdatera batchrun
    await supabase
      .from('batchrun')
      .update({
        status: 'success',
        endtime: new Date().toISOString(),
        numberofrequests: antalOk + antalFel,
        numberoferrors: antalFel,
        numberofrowsafter: afterCount || 0
      })
      .eq('id', batchid);

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
