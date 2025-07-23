const express = require('express');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// GET används av GetResults
app.get('/api/eventor/results', async (req, res) => {
  const { eventId, organisationId } = req.query;

  if (!eventId || !organisationId) {
    return res.status(400).json({ error: 'Missing eventId or organisationId in query' });
  }

  const { data, error } = await supabase
    .from('clubs')
    .select('apikey')
    .eq('organisationid', organisationId)
    .maybeSingle();

  if (error || !data || !data.apikey) {
    return res.status(500).json({ error: 'Could not retrieve API key for organisation' });
  }

  const url = `https://eventor.orientering.se/api/results/organisation?organisationId=${organisationId}&eventId=${eventId}`;
  const response = await fetch(url, {
    headers: { 'ApiKey': data.apikey }
  });

  const body = await response.text();
  res.status(response.status).send(body);
});

// POST används av GetEvents
app.post('/api/eventor/results', async (req, res) => {
  const { organisationId } = req.body;

  if (!organisationId) {
    return res.status(400).json({ error: 'Missing organisationId in body' });
  }

  if (!process.env.EVENTOR_API_KEY) {
    return res.status(500).json({ error: 'Missing EVENTOR_API_KEY in environment' });
  }

  const url = `https://eventor.orientering.se/api/results/organisation?organisationId=${organisationId}`;
  const response = await fetch(url, {
    headers: { 'ApiKey': process.env.EVENTOR_API_KEY }
  });

  const body = await response.text();
  res.status(response.status).send(body);
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
