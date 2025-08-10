// GetEvents/GetEventsLogger.js
// Centraliserad loggning för GetEvents.
// Viktigt: tabellen logdata saknar kolumn "response" – vi använder "comment" istället.

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function nowIso() {
  return new Date().toISOString();
}

async function insertLogData(payload) {
  const row = {
    source: payload?.source || 'GetEvents',
    level: payload?.level || 'info',
    organisationid: payload?.organisationid ?? null,
    request: payload?.request ?? null,
    comment: payload?.comment ?? null, // ingen 'response'-kolumn i schema – använd comment
    timestamp: nowIso(),
    started: nowIso(),
    completed: nowIso(),
    responsecode: payload?.responsecode ?? null,
    batchid: payload?.batchid ?? null,
  };

  const { error } = await supabase.from("logdata").insert(row);
  if (error) {
    console.error("[GetEventsLogger] insertLogData error:", error.message, row);
  }
}

/**
 * Starta loggrad i logdata och returnera id.
 * @param {string} requestUrl
 * @param {string|null} batchid
 * @param {object} meta  { source, organisationid, comment }
 * @returns {Promise<string|null>}
 */
async function logApiStart(requestUrl, batchid, meta = {}) {
  const row = {
    source: meta.source || 'GetEvents',
    level: 'info',
    organisationid: meta.organisationid ?? null,
    batchid: batchid ?? null,
    request: requestUrl,
    comment: meta.comment ?? null,
    timestamp: nowIso(),
    started: nowIso(),
  };

  const { data, error } = await supabase.from("logdata").insert(row).select().single();
  if (error) {
    console.error("[GetEventsLogger] logApiStart error:", error.message, row);
    return null;
  }
  return data.id;
}

/**
 * Avsluta loggrad med statuskod och ev. kommentar.
 * @param {string} id
 * @param {number|null} statusCode
 * @param {string|null} note
 */
async function logApiEnd(id, statusCode = 200, note = null) {
  if (!id) return;
  const patch = {
    completed: nowIso(),
    responsecode: statusCode,
    timestamp: nowIso(),
  };
  if (note != null) patch.comment = String(note).slice(0, 2000);

  const { error } = await supabase.from("logdata").update(patch).eq("id", id);
  if (error) {
    console.error("[GetEventsLogger] logApiEnd error:", error.message, { id, statusCode });
  }
}

/**
 * Logga fel. Om id saknas skapas en ny rad.
 * @param {string|null|Error} idOrError
 * @param {number|string|null} statusCodeOrMsg
 * @param {string|null} message
 * @param {string|null} requestUrl
 * @returns {Promise<string|null>}
 */
async function logApiError(idOrError, statusCodeOrMsg, message, requestUrl) {
  // Om första parametern är ett befintligt id – uppdatera den raden som fel
  if (typeof idOrError === "string" && idOrError.length > 0) {
    const patch = {
      level: 'error',
      completed: nowIso(),
      responsecode: typeof statusCodeOrMsg === 'number' ? statusCodeOrMsg : null,
      comment: [statusCodeOrMsg, message].filter(Boolean).map(String).join(' | ').slice(0, 2000),
      timestamp: nowIso(),
    };
    const { error } = await supabase.from("logdata").update(patch).eq("id", idOrError);
    if (error) {
      console.error("[GetEventsLogger] logApiError update error:", error.message, { id: idOrError });
    }
    return idOrError;
  }

  // Annars skapa ny felrad
  const row = {
    source: 'GetEvents',
    level: 'error',
    request: requestUrl ?? null,
    comment: [statusCodeOrMsg, message].filter(Boolean).map(String).join(' | ').slice(0, 2000),
    timestamp: nowIso(),
    started: nowIso(),
    completed: nowIso(),
  };

  const { data, error } = await supabase.from("logdata").insert(row).select().single();
  if (error) {
    console.error("[GetEventsLogger] logApiError insert error:", error.message, row);
    return null;
  }
  return data.id;
}

module.exports = {
  insertLogData,
  logApiStart,
  logApiEnd,
  logApiError,
};
