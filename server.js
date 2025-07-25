const express = require('express');
const dotenv = require('dotenv');
const axios = require('axios');
const xml2js = require('xml2js');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();
const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Routrar
const getEventsRouter = require('./GetEvents/GetEventsRouter.js');
const getResultsRouter = require('./GetResults/GetResultsRouter.js');
const getEventsTestRouter = require('./GetEvents/GetEventsTestRouter');

app.use('/api', getEventsRouter);
app.use('/api', getResultsRouter);
app.use('/api', getEventsTestRouter);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Proxy för Eventor-anrop – använder x-api-key från headers
app.get('/api/eventor/results', async (req, res) => {
  try {
    const { organisationId, eventId } = req.query;
    const apiKey = req.headers['x-api-key'];

    if (!organisationId || !eventId || !apiKey) {
      return res.status(400).json({ error: 'Missing organisationId, eventId eller x-api-key' });
    }

    const url = 'https://eventor.orientering.se/api/results/organisation';

    // DEBUGLOGG
    console.log('[Proxy] API-nyckel mottagen:', apiKey);
    console.log('[Proxy] Anropar Eventor med URL:', url);
    console.log('[Proxy] Parametrar:', {
      organisationIds: organisationId,
      eventId: eventId,
      includeTrackCompetitors: false,
      includeSplitTimes: false,
      includeTimes: true,
      includeAdditionalResultValues: false
    });

    const response = await axios.get(url, {
      params: {
        organisationIds: organisationId,
        eventId: eventId,
        includeTrackCompetitors: false,
        includeSplitTimes: false,
        includeTimes: true,
        includeAdditionalResultValues: false
      },
      headers: {
        Accept: 'application/xml',
        ApiKey: apiKey // ✅ skickas som header
      }
    });

    res.set('Content-Type', 'application/xml');
    res.status(200).send(response.data);
  } catch (err) {
    console.error('[Proxy error]', err.message);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// Starta server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servern kör på port ${PORT}`);
});
