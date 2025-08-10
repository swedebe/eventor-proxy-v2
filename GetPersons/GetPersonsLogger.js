// GetPersons/GetPersonsLogger.js
// Logger for GetPersons. Uses 'logdata' table with columns: source, level, organisationid, request, comment, started, completed, responsecode, batchid.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function nowIso() {
  return new Date().toISOString();
}

async function insertLogData(payload) {
  const row = {
    source: payload?.source || 'GetPersons',
    level: payload?.level || 'info',
    organisationid: payload?.organisationid ?? null,
    eventid: payload?.eventid ?? null,
    eventraceid: payload?.eventraceid ?? null,
    personid: payload?.personid ?? null,
    request: payload?.request ?? null,
    comment: payload?.comment ?? null,
    started: nowIso(),
    completed: nowIso(),
    responsecode: payload?.responsecode ?? null,
    batchid: payload?.batchid ?? null,
  };
  const { error } = await supabase.from('logdata').insert(row);
  if (error) {
    console.error('[GetPersonsLogger] insertLogData error:', error.message, row);
  }
  return row;
}

async function logApiStart({ source, organisationid, request, comment }) {
  const row = {
    source: source || 'GetPersons',
    level: 'info',
    organisationid: organisationid ?? null,
    request: request ?? null,
    comment: comment ?? null,
    started: nowIso(),
  };
  const { data, error } = await supabase.from('logdata').insert(row).select().single();
  if (error) {
    console.error('[GetPersonsLogger] logApiStart error:', error.message, row);
    return null;
  }
  return data?.id ?? null;
}

async function logApiEnd(id, responseCode) {
  if (!id) return;
  const { error } = await supabase
    .from('logdata')
    .update({
      completed: nowIso(),
      responsecode: responseCode || '200 OK',
    })
    .eq('id', id);
  if (error) {
    console.error('[GetPersonsLogger] logApiEnd error:', error.message);
  }
}

async function logApiError(id, err) {
  const code = err?.response?.status ? String(err.response.status) : (err?.message || 'error');
  if (id) {
    const { error } = await supabase
      .from('logdata')
      .update({
        completed: nowIso(),
        responsecode: code,
        comment: `[API error] ${err?.message || 'unknown'}`,
      })
      .eq('id', id);
    if (error) {
      console.error('[GetPersonsLogger] logApiError update error:', error.message);
    }
  } else {
    await insertLogData({
      source: 'GetPersons',
      level: 'error',
      comment: `[API error] ${err?.message || 'unknown'}`,
      responsecode: code,
    });
  }
}

module.exports = {
  insertLogData,
  logApiStart,
  logApiEnd,
  logApiError,
};
