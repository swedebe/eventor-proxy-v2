const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { logApiCall } = require('./GetEventsLogger');

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

  try {
    const response = await axios.get(url, {
      headers: { ApiKey: EVENTOR_API_KEY },
    });

    console.log('Eventor response status:', response.status);
    console.log('Raw XML:\n', response.data); // 🧾 Här loggar vi hela svaret

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

  return { insertedCount: 0 }; // Temporärt, vi skriver inget till databasen
}

module.exports = { fetchAndStoreEvents };
