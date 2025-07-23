app.get('/api/eventor/results', async (req, res) => {
  const { eventId, organisationId } = req.query;

  if (!eventId || !organisationId) {
    return res.status(400).send('Missing eventId or organisationId');
  }

  const { createClient } = require('@supabase/supabase-js');
  const fetch = require('node-fetch');

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Hämta API-nyckeln från Supabase
  const { data, error } = await supabase
    .from('clubs')
    .select('apikey')
    .eq('organisationid', organisationId)
    .single();

  if (error || !data?.apikey) {
    console.error(`[server.js] Kunde inte hämta apikey för organisationId=${organisationId}`, error?.message);
    return res.status(500).send('Kunde inte hämta API-nyckel från databasen');
  }

  const apiKey = data.apikey;

  // Skapa Eventor-URL med nyckel
  const eventorUrl = `https://eventor.orientering.se/api/results/organisation?eventId=${eventId}&organisationId=${organisationId}&apiKey=${apiKey}`;

  try {
    const response = await fetch(eventorUrl, {
      headers: {
        Accept: 'application/xml'
      }
    });

    const xml = await response.text();
    return res.type('application/xml').send(xml);
  } catch (err) {
    console.error('[server.js] Fel vid hämtning från Eventor:', err.message);
    return res.status(500).send('Fel vid hämtning från Eventor');
  }
});
