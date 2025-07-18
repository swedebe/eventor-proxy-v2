const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { logApiCall } = require('./GetEventsLogger');
const { parseStringPromise } = require('xml2js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EVENTOR_API_KEY = process.env.EVENTOR_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const EVENTOR_API_BASE = 'https://eventor.orientering.se/api';

async function fetchAndStoreEvents(organisationId) {
  const today = new Date();
  const fromDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fromDateStr = `${fromDate.toISOString().split('T')[0]} 00:00:00`;
  const toDateStr = `${today.toISOString().split('T')[0]} 23:59:59`;

  const url = `${EVENTOR_API_BASE}/events?fromDate=${encodeURIComponent(fromDateStr)}&toDate=${encodeURIComponent(toDateStr)}&classificationIds=1,2,3,6&EventStatusId=3`;

  const log = await logApiCall({ request: url });

  let xml;
  try {
    const response = await axios.get(url, {
      headers: { ApiKey: EVENTOR_API_KEY },
    });

    console.log('Eventor response status:', response.status);
    xml = response.data;

    console.log('Raw XML:', xml); // Debug-logg

    await supabase
      .from('logdata')
      .update({ responsecode: '200 OK', completed: new Date().toISOString() })
      .eq('id', log.id);
  } catch (err) {
    console.error('Axios error response:', err.response?.data || err.message);
    await supabase
      .from('logdata')
      .update({
        responsecode: err.response?.status || 'ERR',
        errormessage: err.message,
        completed: new Date().toISOString(),
      })
      .eq('id', log.id);
    throw err;
  }

  const result = await parseStringPromise(xml);
  const events = (result.Events?.Event || []).flatMap(event => {
    const eventId = parseInt(event.EventId?.[0]);
    const name = event.Name?.[0];
    const organisers = (event.Organisers?.[0]?.Organiser || [])
      .map(o => o.Organisation?.[0]?.Name?.[0])
      .filter(Boolean)
      .join(',');
    const classificationId = parseInt(event.EventClassificationId?.[0]);

    const races = Array.isArray(event.EventRace) ? event.EventRace : [event.EventRace];
    return races.map(race => ({
      EventId: eventId,
      EventRaceId: parseInt(race.EventRaceId?.[0]),
      EventDate: race.RaceDate?.[0]?.Date?.[0] || race.EventDate?.[0],
      Event_Name: name,
      Event_Organiser: organisers,
      EventClassificationId: classificationId,
    }));
  });

  const inserted = [];
  for (const e of events) {
    const { error } = await supabase
      .from('Tävlingar')
      .upsert(e, { onConflict: 'EventRaceId' });
    if (!error) inserted.push(e);
    else console.error('Insert error:', e, error);
  }

  return { insertedCount: inserted.length };
}

module.exports = { fetchAndStoreEvents };
