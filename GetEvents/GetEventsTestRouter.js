const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { logApiCall, logBatchStart, logBatchEnd } = require('./GetEventsLogger');
const { saveEventsToSupabase } = require('./GetEventsFetcher');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const EVENTOR_API_BASE = 'https://eventor.orientering.se/api';

const testEventIds = [46964, 51284, 44952];

router.post('/test-events', async (req, res) => {
  const organisationId = req.body.organisationId;
  if (!organisationId) {
    return res.status(400).json({ error: 'organisationId is required' });
  }

  const apiKey = req.body.apikey || process.env.EVENTOR_API_KEY;

  console.log(`[GetEventsTestRouter] Startar testimport för organisation ${organisationId}`);
  const batchInfo = await logBatchStart(supabase, organisationId, 'TEST GetEvents');

  let deletedEvents = 0;
  let deletedEventRaces = 0;
  let insertedEvents = 0;
  let insertedEventRaces = 0;

  try {
    // Ta bort ev. tidigare rader
    const { count: countEventRaces } = await supabase
      .from('eventraces')
      .delete()
      .in('eventid', testEventIds)
      .select('*', { count: 'exact' });

    const { count: countEvents } = await supabase
      .from('events')
      .delete()
      .in('eventid', testEventIds)
      .select('*', { count: 'exact' });

    deletedEventRaces = countEventRaces || 0;
    deletedEvents = countEvents || 0;

    console.log(`[GetEventsTestRouter] Raderade ${deletedEvents} events och ${deletedEventRaces} eventraces`);

    const allEvents = [];

    for (const eventId of testEventIds) {
      const url = `${EVENTOR_API_BASE}/events?eventId=${eventId}`;
      const started = new Date();
      console.log(`[GetEventsTestRouter] Hämtar eventId=${eventId}`);

      try {
        const response = await axios.get(url, {
          headers: { 'ApiKey': apiKey },
        });

        await logApiCall(supabase, url, started, new Date(), '200 OK', null);

        const eventList = response.data?.EventList?.Event;
        if (Array.isArray(eventList)) {
          allEvents.push(...eventList);
        } else if (eventList) {
          allEvents.push(eventList);
        }
      } catch (err) {
        const responseCode = err.response?.status || 500;
        const errorMsg = err.response?.data || err.message;

        console.error(`[GetEventsTestRouter] Fel vid hämtning av eventId=${eventId}:`, responseCode, errorMsg);

        await logApiCall(supabase, url, started, new Date(), `${responseCode}`, errorMsg);
        throw new Error(`Kunde inte hämta eventId=${eventId}`);
      }
    }

    const saveResult = await saveEventsToSupabase(supabase, allEvents, organisationId, batchInfo.batchid);
    insertedEvents = saveResult.eventCount;
    insertedEventRaces = saveResult.raceCount;

    await logBatchEnd(supabase, batchInfo.batchid, 'success', `Testimport färdig: ${insertedEvents} events`);
    console.log(`[GetEventsTestRouter] Import klar. ${insertedEvents} events och ${insertedEventRaces} eventraces importerade.`);

    res.json({
      success: true,
      deletedEvents,
      deletedEventRaces,
      insertedEvents,
      insertedEventRaces,
      batchid: batchInfo.batchid,
    });
  } catch (err) {
    console.error('[GetEventsTestRouter] Fel under testimport:', err.message);
    await logBatchEnd(supabase, batchInfo.batchid, 'fail', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
