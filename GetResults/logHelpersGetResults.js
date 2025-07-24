// logHelpers.js – används endast av GetResults

async function insertLogData(supabase, {
  source,
  level,
  errormessage = null,
  organisationid = null,
  eventid = null,
  batchid = null,
  request = null
}) {
  const { error } = await supabase.from('logdata').insert([{
    source,
    level,
    errormessage,
    organisationid,
    eventid,
    batchid,
    request,
    timestamp: new Date().toISOString()
  }]);

  if (error) {
    console.error(`[LogHelper] Kunde inte logga till logdata: ${error.message}`);
  }
}

module.exports = { insertLogData };
