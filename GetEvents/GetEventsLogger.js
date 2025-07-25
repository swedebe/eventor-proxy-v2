const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Enkel variant för gammal kod som bara skickar { request }
async function logApiCallSimple({ request }) {
  return await logApiCall(supabase, request, new Date(), new Date(), null, null);
}

// Ny flexibel loggfunktion för alla API-anrop
async function logApiCall(supabaseClient, request, started, completed, responsecode, errormessage) {
  const { data, error } = await supabaseClient
    .from('logdata')
    .insert([
      {
        request,
        started: started.toISOString(),
        completed: completed.toISOString(),
        responsecode,
        errormessage: errormessage || null,
      },
    ])
    .select()
    .single();

  if (error) {
    console.error('Fel vid loggning av API-anrop:', error.message);
    throw new Error('Kunde inte logga API-anrop');
  }

  return data;
}

// Startar en ny batch och returnerar batchid
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

  return { batchid: data.id };
}

// Avslutar en batch med status och kommentar
async function logBatchEnd(supabaseClient, batchid, status, comment) {
  const { error } = await supabaseClient
    .from('batchrun')
    .update({
      endtime: new Date().toISOString(),
      status,
      comment: comment || null,
    })
    .eq('id', batchid);

  if (error) {
    console.error('Fel vid loggning av batchslut:', error.message);
  }
}

module.exports = {
  logApiCallSimple,
  logApiCall,
  logBatchStart,
  logBatchEnd,
};
