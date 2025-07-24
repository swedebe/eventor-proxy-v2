const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function logApiCall(supabaseClient, request, started, ended, status, errorMessage) {
  const { error } = await supabaseClient
    .from('logdata')
    .insert([
      {
        request,
        started: started.toISOString(),
        ended: ended.toISOString(),
        statuscode: status,
        errormessage: errorMessage || null,
      },
    ]);

  if (error) {
    console.error('Fel vid loggning av API-anrop:', error.message);
  }
}

async function logBatchStart(supabaseClient, organisationid, comment) {
  const { data, error } = await supabaseClient
    .from('batchrun')
    .insert([
      {
        starttime: new Date().toISOString(),
        clubparticipation: organisationid,
        comment: comment || null,
        status: 'started',
      },
    ])
    .select()
    .single();

  if (error) {
    console.error('Fel vid loggning av batchstart:', error.message);
    throw new Error('Kunde inte logga batchstart');
  }

  return data;
}

async function logBatchEnd(supabaseClient, batchid, status, comment) {
  const { error } = await supabaseClient
    .from('batchrun')
    .update({
      endtime: new Date().toISOString(),
      status,
      comment: comment || null,
    })
    .eq('batchid', batchid);

  if (error) {
    console.error('Fel vid loggning av batchslut:', error.message);
  }
}

module.exports = {
  logApiCall,
  logBatchStart,
  logBatchEnd,
};
