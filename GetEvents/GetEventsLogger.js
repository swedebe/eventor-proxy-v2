const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function logApiCall({ anrop }) {
  const { data, error } = await supabase
    .from('Loggdata')
    .insert([{ Anrop: anrop, Startad: new Date().toISOString() }])
    .select()
    .single();

  if (error) {
    console.error('Failed to log API call:', error);
    throw new Error('Could not log API call');
  }

  return data;
}

module.exports = { logApiCall };
