const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { logApiCall, logBatchStart, logBatchEnd } = require('./GetEventsLogger');
const { saveEventsToSupabase } = require('./GetEventsFetcher');
const { parseStringPromise } = require('xml2js');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const EVENTOR_API_BASE = 'https://eventor.orientering.se/api';

const testDates = [
  '2024-07-09',
  '2024-10-12'
];

router.post('/test-events', async (req, res) => {
  const organisationId = req.body.organisationId;
  if (!organisationId) {
    return res.status(400).json({ error: 'organisationId is required' });
  }

  console.log(`[GetEventsTestRouter] Startar testimport för organisation ${organisationId}`);
  const batchInfo = await logBatchStart(supabase, organisationId, 'TEST GetEvents');

  // Hämta API-nyckel från Supabase
  const { data: club, error: clubError } = await supabase
    .from('clubs')
    .select('apikey')
    .eq('organisationid', organisationId)
    .single();

  if (clubError || !club?.apikey) {
    await logBatchEnd(supabase, batchInfo.batchid, 'fail', 'API-nyckel saknas');
    return res.status(400).json({ error: 'API-nyckel saknas för organisationen' });
  }

  const apiKey = club.apikey;
  const allEvents = [];

  try {
    for (const date of testDates) {
      const fromDate = `${date} 00:00:00`;
      const toDate = `${date} 23:59:59`;
      const url = `${EVENTOR_API_BASE}/events?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}&classificationIds=1,2,3,6&EventStatusId=3`;

      const started = new Date();
      console.log(`[GetEventsTestRouter] Hämtar datum ${date}`);

      try {
        const response = await axios.get(url, {
          headers: { ApiKey: apiKey },
        });

        await logApiCall(supabase, url, started, new Date(), '200 OK', null);

        const xml = response.data;
        const parsed = await parseStringPromise(xml);
        const eventList = parsed?.EventList?.Event;
        if (Array.isArray(eventList)) {
          allEvents.push(...eventList);
        } else if (eventList) {
          allEvents.push(eventList);
        }

      } catch (err) {
        const responseCode = err.response?.status || 500;
        const errorMsg = err.response?.data || err.message;

        console.error(`[GetEventsTestRouter] Fel vid hämtning av datum ${date}:`, responseCode, errorMsg);
        await logApiCall(supabase, url, started, new Date(), `${responseCode}`, errorMsg);
        throw new Error(`Kunde inte hämta tävlingar för datum ${date}`);
      }
    }

    const saveResult = await saveEventsToSupabase(supabase, allEvents, organisationId, batchInfo.batchid);
    const insertedEvents = saveResult.eventCount;
    const insertedEventRaces = saveResult.raceCount;

    await logBatchEnd(supabase, batchInfo.batchid, 'success', `Testimport färdig: ${insertedEvents} events`);

    console.log(`[GetEventsTestRouter] Import klar. ${insertedEvents} events och ${insertedEventRaces} eventraces importerade.`);
    res.json({
      success: true,
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
