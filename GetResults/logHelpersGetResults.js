const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Logga att en resultatkörning startar: raderar gamla resultat + uppdaterar tableupdates
async function logResultRunStart(batchid, organisationid, eventid) {
  try {
    const { error } = await supabase
      .from('results')
      .delete()
      .eq('eventid', eventid)
      .eq('clubparticipation', organisationid);

    if (error) throw new Error(error.message);

    const { error: updError } = await supabase
      .from('tableupdates')
      .upsert({
        tablename: 'results',
        updated: new Date().toISOString(),
        batchid
      });

    if (updError) throw new Error(updError.message);

  } catch (err) {
    console.error('[logResultRunStart] Fel vid radering eller upsert:', {
      batchid,
      organisationid,
      eventid,
      error: err.message
    });
    throw err;
  }
}

// Logga ett meddelande till logdata-tabellen
async function insertLogData(supabase, logObj) {
  const { error } = await supabase.from('logdata').insert(logObj);
  if (error) throw new Error(error.message);
}

module.exports = {
  logResultRunStart,
  insertLogData
};
