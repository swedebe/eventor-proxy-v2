// routes/batch.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const xml2js = require('xml2js');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Hjälpfunktion: hämta Eventor-data
async function fetchEventorData() {
  const from = '2025-05-01 00:00:00';
  const to = '2025-06-03 23:59:59';
  const classification = '1,2,3,6';
  const status = '3';
  const url = `https://eventor.orientering.se/api/events?fromDate=${from}&toDate=${to}&classificationIds=${classification}&EventStatusId=${status}`;

  const response = await axios.get(url, {
    headers: {
      ApiKey: process.env.EVENTOR_API_KEY,
    },
    responseType: 'text',
  });

  const parser = new xml2js.Parser({ explicitArray: false });
  const parsed = await parser.parseStringPromise(response.data);
  return parsed.EventList?.Event ?? [];
}

// Route: Testar att hämta och spara eventor-tävlingar
router.get('/test-eventor-anrop', async (req, res) => {
  try {
    const events = await fetchEventorData();
    console.log(`Antal tävlingar att bearbeta: ${events.length}`);

    const max = 5; // Hämta endast första 5 rader temporärt

    for (const e of events.slice(0, max)) {
      const race = {
        eventId: parseInt(e.EventId),
        eventRaceId: parseInt(e.EventRace?.EventRaceId || 0),
        eventDate: e.EventRace?.RaceDate?.Date,
        eventName: e.Name,
        eventOrganiser: Array.isArray(e.Organiser?.OrganisationId)
          ? e.Organiser.OrganisationId[0]
          : e.Organiser?.OrganisationId || '',
        eventDistance: e.EventRace?.WRSInfo?.Distance || '',
        event_classification_id: parseInt(e.EventClassificationId || 0),
      };

      console.log('Försöker spara:', race);

      const { error } = await supabase.from('events').insert(race);
      if (error) {
        console.log(`Fel vid insert för race ${race.eventRaceId}: ${error.message}`);
      } else {
        console.log(`Sparad race ${race.eventRaceId}`);
      }
    }

    await supabase.from('testlog').insert({ message: 'Insertförsök till events klar' });

    res.send('Insertförsök till events klar – se logg');
  } catch (error) {
    console.error('Fel i test-eventor-anrop:', error);
    res.status(500).send('Fel vid körning – se Render-logg');
  }
});

module.exports = router;
