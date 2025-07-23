// logHelpers.js – används endast av GetResults

async function insertLogData(supabase, {
  source,
  level,
  message,
  organisationid = null,
  eventid = null,
  batchid = null
}) {
  const { error } = await supabase.from('logdata').insert([{
    source,
    level,
    message,
    organisationid,
    eventid,
    batchid,
    timestamp: new Date().toISOString()
  }]);

  if (error) {
    console.error(`[LogHelper] Kunde inte logga till logdata: ${error.message}`);
  }
}

module.exports = { insertLogData };
