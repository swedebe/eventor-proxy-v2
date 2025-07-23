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

app.use(getEventsRouter);
app.use(getResultsRouter);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Proxy för Eventor-anrop med dynamisk API-nyckel
app.get('/api/eventor/results', async (req, res) => {
  try {
    const { organisationId, eventId } = req.query;
    if (!organisationId || !eventId) {
      return res.status(400).json({ error: 'Missing organisationId or eventId' });
    }

    const { data: clubs, error } = await supabase
      .from('clubs')
      .select('apikey')
      .eq('organisationid', organisationId)
      .single();

    if (error || !clubs?.apikey) {
      return res.status(404).json({ error: 'API key not found for organisationId' });
    }

    const EVENTOR_API_KEY = clubs.apikey;
    const EVENTOR_BASE_URL = 'https://eventor.orientering.se/api/results/organisation';
    const response = await axios.get(EVENTOR_BASE_URL, {
      params: {
        organisationId,
        eventId,
        includeTrackCompetitors: false,
        apiKey: EVENTOR_API_KEY,
      },
      headers: { Accept: 'application/xml' },
    });

    res.set('Content-Type', 'application/xml');
    res.status(200).send(response.data);
  } catch (err) {
    console.error('[Proxy error]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Starta server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servern kör på port ${PORT}`);
});
