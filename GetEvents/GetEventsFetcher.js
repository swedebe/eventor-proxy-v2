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

  const events = (result.EventList?.Event || []).flatMap(event => {
    const eventid = parseInt(event.EventId?.[0]);
    const eventname = event.Name?.[0];
    const eventorganiser = (event.Organisers?.[0]?.Organiser || [])
      .map(o => o.Organisation?.[0]?.Name?.[0])
      .filter(Boolean)
      .join(',');
    const eventclassificationid = parseInt(event.EventClassificationId?.[0]);

    const races = Array.isArray(event.EventRace) ? event.EventRace : [event.EventRace];
    if (!races || !races[0]) return [];

    return races.map(race => ({
      eventid,
      eventraceid: parseInt(race.EventRaceId?.[0]),
      eventdate: race.RaceDate?.[0]?.Date?.[0] || race.EventDate?.[0],
      eventname,
      eventorganiser,
      eventclassificationid,
      batchid: log.id, // 👈 här kopplar vi raden till loggen
    }));
  });

  const inserted = [];
  for (const e of events) {
    console.log('Will insert event:', e);
    const { error } = await supabase
      .from('events')
      .upsert(e, { onConflict: 'eventraceid' });
    if (!error) inserted.push(e);
    else console.error('Insert error:', e, error);
  }

  return { insertedCount: inserted.length };
}

module.exports = { fetchAndStoreEvents };
