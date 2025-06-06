// routes/batch.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const xml2js = require('xml2js');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const parser = new xml2js.Parser({ explicitArray: false });

router.get('/test-eventor-anrop', async (req, res) => {
  const from = '2025-05-01 00:00:00';
  const to = '2025-05-05 23:59:59';
  const url = `${process.env.SELF_BASE_URL}/api/events?fromDate=${encodeURIComponent(from)}&toDate=${encodeURIComponent(to)}&classificationIds=1,2,3,6&EventStatusId=3`;

  try {
    const response = await axios.get(url, {
      headers: { ApiKey: process.env.EVENTOR_API_KEY },
      responseType: 'text',
    });

    const result = await parser.parseStringPromise(response.data);
    const events = result.EventList?.Event || [];
    const eventsArray = Array.isArray(events) ? events : [events];
    console.log('Antal tävlingar att bearbeta:', eventsArray.length);

    for (const event of eventsArray.slice(0, 5)) {
      const data = {
        eventid: parseInt(event.EventId),
        eventraceid: parseInt(event.EventRace?.EventRaceId || 0),
        eventdate: event.EventRace?.RaceDate?.Date || null,
        eventname: event.Name || null,
        eventorganiser: Array.isArray(event.Organiser?.OrganisationId)
          ? event.Organiser.OrganisationId[0]
          : event.Organiser?.OrganisationId || null,
        eventdistance: event.EventRace?.WRSInfo?.Distance || null,
        eventclassificationid: parseInt(event.EventClassificationId || 0),
      };

      console.log('Försöker spara:', data);

      const { error } = await supabase.from('events').insert(data);
      if (error) {
        console.log(`Fel vid insert för race ${data.eventraceid}: ${error.message}`);
      } else {
        console.log(`Sparad race ${data.eventraceid}`);
      }
    }

    await supabase.from('testlog').insert({ message: 'Insertförsök till events klar' });
    res.send('Insertförsök till events klar – se logg');
  } catch (err) {
    console.error('Fel vid anrop/parsing:', err.message);
    res.status(500).send('Fel vid hämtning eller parsing');
  }
});

module.exports = router;
