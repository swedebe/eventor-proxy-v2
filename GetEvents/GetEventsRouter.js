const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { fetchEvents } = require('./GetEventsFetcher.js');
const { insertLogData } = require('./logHelpersGetResults.js');

// Skapa supabase-klient med service-rollnyckel
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * POST /api/update-events
 * Kör import av tävlingar inom ett angivet datumintervall. Body kan innehålla
 * fromDate (YYYY-MM-DD), toDate (YYYY-MM-DD) och classificationIds (array av int).
 * Om datum saknas används senaste 30 dagarna. Om classificationIds saknas
 * används standardklasser [1,2,3,6].
 */
router.post('/update-events', async (req, res) => {
  console.log('[GetEventsRouter] Startar uppdatering av tävlingar');
  const body = req.body || {};
  const fromDate = body.fromDate || null;
  const toDate = body.toDate || null;
  const classificationIds = Array.isArray(body.classificationIds) ? body.classificationIds : null;

  // Räkna antal rader innan import (alla rader i events)
  let beforeCount = 0;
  try {
    const { count, error } = await supabase
      .from('events')
      .select('*', { count: 'exact', head: true });
    if (error) {
      console.error('[GetEventsRouter] Fel vid count (före):', error.message);
    } else {
      beforeCount = count || 0;
    }
  } catch (e) {
    console.error('[GetEventsRouter] Ovänterat fel vid count (före):', e.message);
  }

  // Skapa batchrun-post
  let batch;
  try {
    const { data, error } = await supabase
      .from('batchrun')
      .insert({
        clubparticipation: null,
        comment: 'GetEvents',
        status: 'started',
        initiatedby: 'manual',
        appversion: 'v1',
        renderjobid: process.env.RENDER_INSTANCE_ID || null,
        starttime: new Date().toISOString(),
        numberofrowsbefore: beforeCount
      })
      .select()
      .single();
    if (error) {
      console.error('[GetEventsRouter] Fel vid skapande av batchrun:', error.message);
      return res.status(500).json({ error: 'Fel vid batchrun skapande' });
    }
    batch = data;
  } catch (e) {
    console.error('[GetEventsRouter] Ovänterat fel vid batchrun skapande:', e.message);
    return res.status(500).json({ error: 'Ovänterat fel vid batchrun' });
  }

  const batchid = batch.id;
  // Logga start av import
  try {
    await insertLogData(supabase, {
      source: 'GetEventsRouter',
      level: 'info',
      batchid,
      comment: `Uppdaterar tävlingar: fromDate=${fromDate ?? 'auto'}, toDate=${toDate ?? 'auto'}, classes=${classificationIds ?? 'default'}`
    });
  } catch (e) {
    console.warn('[GetEventsRouter] Misslyckades logga start av import:', e.message);
  }

  // Kör själva importen
  let result;
  try {
    result = await fetchEvents({ fromDate, toDate, classificationIds, batchid });
  } catch (e) {
    console.error('[GetEventsRouter] Ovänterat fel vid fetchEvents:', e);
    result = { success: false, insertedRows: 0 };
  }

  // Räkna antal rader efter import
  let afterCount = 0;
  try {
    const { count, error } = await supabase
      .from('events')
      .select('*', { count: 'exact', head: true });
    if (error) {
      console.error('[GetEventsRouter] Fel vid count (efter):', error.message);
    } else {
      afterCount = count || 0;
    }
  } catch (e) {
    console.error('[GetEventsRouter] Ovänterat fel vid count (efter):', e.message);
  }

  // Uppdatera batchrun med slutstatus
  try {
    await supabase
      .from('batchrun')
      .update({
        status: result && result.success === false ? 'error' : 'success',
        endtime: new Date().toISOString(),
        numberofrequests: 1,
        numberoferrors: result && result.success === false ? 1 : 0,
        numberofrowsafter: afterCount
      })
      .eq('id', batchid);
  } catch (e) {
    console.error('[GetEventsRouter] Fel vid uppdatering av batchrun:', e.message);
  }

  console.log('[GetEventsRouter] Import av tävlingar klar');
  if (result && result.success === false) {
    return res.status(500).json({ error: 'Fel vid uppdatering av tävlingar' });
  }
  return res.status(200).json({ insertedRows: result.insertedRows });
});

module.exports = router;