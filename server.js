const express = require('express');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Koppla in routrar för GetEvents och GetResults
const getEventsRouter = require('./GetEvents/GetEventsRouter.js');
const getResultsRouter = require('./GetResults/GetResultsRouter.js');
app.use('/api', getEventsRouter);
app.use('/api', getResultsRouter);

// Proxy som används av GetResultsFetcher
app.get('/api/eventor/results', async (req, res) => {
  const { eventId, organisationId } = req.query;

  if (!eventId || !organisationId) {
    return res.status(400).send('Missing eventId or organisationId');
  }

  const { data, error } = await supabase
    .from('clubs')
    .select('apikey')
    .eq('organisationid', organisationId)
    .single();

  if (error || !data?.apikey) {
    console.error(`[server.js] Kunde inte hämta API-nyckel för organisationId=${organisationId}`, error?.message);
    return res.status(500).send('Kunde inte hämta API-nyckel från databasen');
  }

  const eventorUrl = `https://eventor.orientering.se/api/results/organisation?eventId=${eventId}&organisationId=${organisationId}`;

  try {
    const response = await fetch(eventorUrl, {
      headers: {
        'ApiKey': data.apikey,
        'Accept': 'application/xml'
      }
    });

    const xml = await response.text();
    return res.type('application/xml').status(response.status).send(xml);
  } catch (err) {
    console.error('[server.js] Fel vid hämtning från Eventor:', err.message);
    return res.status(500).send('Fel vid hämtning från Eventor');
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
