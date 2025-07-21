// GetPersonsLogger.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function logEventorRequest({ url, started, completed, status, error }) {
  const { error: insertError } = await supabase.from('logdata').insert([
    {
      request: url,
      started,
      completed,
      responsecode: status ? `${status}` : null,
      errormessage: error || null
    }
  ]);

  if (insertError) {
    console.error('Failed to log request:', insertError);
  }
}
