// GetResults/logHelpersGetResults.js
// Centraliserad loggning för GetResults.
// Viktigt: tabellen logdata saknar kolumn "response" – vi använder "comment" istället.
// Alltid sätt timestamp/started/completed och fyll responsecode där det går.

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getClient(potentialClient) {
  if (potentialClient && typeof potentialClient.from === "function") {
    return potentialClient;
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * insertLogData([supabase], payload)
 * payload:
 *  - source, level, organisationid, eventid, batchid, request,
 *    errormessage, comment, responsecode, started, completed
 * Sätter alltid: timestamp och started (om saknas).
 */
async function insertLogData(arg1, arg2) {
  const hasClient = arg2 !== undefined;
  const supabase = getClient(hasClient ? arg1 : undefined);
  const payload = hasClient ? arg2 : arg1;

  const row = {
    source: payload.source ?? "unknown",
    level: payload.level ?? "info",
    organisationid: payload.organisationid ?? null,
    eventid: payload.eventid ?? null,
    batchid: payload.batchid ?? null,
    request: payload.request ?? null,
    errormessage: payload.errormessage ?? null,
    comment: payload.comment ?? null,
    responsecode: payload.responsecode ?? null,
    timestamp: nowIso(),
    started: payload.started ?? nowIso(),
    completed: payload.completed ?? null,
  };

  const { data, error } = await supabase.from("logdata").insert(row).select().single();
  if (error) {
    console.error("[logHelpersGetResults] insertLogData error:", error.message, row);
    return null;
  }
  return data;
}

/**
 * logApiStart(requestUrl, batchid, meta?)
 * Returnerar id för den skapade loggraden.
 */
async function logApiStart(requestUrl, batchid, meta = {}) {
  const supabase = getClient();
  const row = {
    source: meta.source ?? "GetResultsFetcher",
    level: "info",
    batchid,
    organisationid: meta.organisationid ?? null,
    eventid: meta.eventid ?? null,
    request: requestUrl,
    comment: meta.comment ?? null,
    timestamp: nowIso(),
    started: nowIso(),
  };

  const { data, error } = await supabase.from("logdata").insert(row).select().single();
  if (error) {
    console.error("[logApiStart] insert error:", error.message, row);
    return null;
  }
  return data.id;
}

/**
 * logApiEnd(id, statusCode=200, note=null)
 * Sätter completed + responsecode. 'note' skrivs till comment.
 */
async function logApiEnd(id, statusCode = 200, note = null) {
  if (!id) return;
  const supabase = getClient();
  const patch = {
    completed: nowIso(),
    responsecode: statusCode,
    timestamp: nowIso(),
  };
  if (note != null) patch.comment = String(note).slice(0, 2000);

  const { error } = await supabase.from("logdata").update(patch).eq("id", id);
  if (error) {
    console.error("[logApiEnd] update error:", error.message, { id, statusCode });
  }
}

/**
 * logApiError(idOrMeta, statusOrError, message?, requestUrl?)
 * Användning:
 *  - logApiError(existingId, statusCode, message, url)
 *  - logApiError(null, errorObj, message, url) // skapar ny rad
 */
async function logApiError(idOrMeta, statusOrError, message, requestUrl) {
  const supabase = getClient();
  const now = nowIso();

  let statusCode = null;
  let errorMessage = message ?? null;

  if (statusOrError && typeof statusOrError === "object") {
    statusCode = statusOrError?.response?.status ?? -1;
    if (!errorMessage) errorMessage = statusOrError?.message ?? "error";
  } else {
    statusCode = statusOrError ?? -1;
  }

  if (idOrMeta) {
    const patch = {
      completed: now,
      responsecode: statusCode,
      errormessage: errorMessage,
      timestamp: now,
    };
    if (requestUrl) patch.request = requestUrl;

    const { error } = await supabase.from("logdata").update(patch).eq("id", idOrMeta);
    if (error) {
      console.error("[logApiError] update error:", error.message, { id: idOrMeta, statusCode });
    }
    return idOrMeta;
  }

  const row = {
    source: "GetResultsFetcher",
    level: "error",
    request: requestUrl ?? null,
    responsecode: statusCode,
    errormessage: errorMessage,
    timestamp: now,
    started: now,
    completed: now,
  };

  const { data, error } = await supabase.from("logdata").insert(row).select().single();
  if (error) {
    console.error("[logApiError] insert error:", error.message, row);
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
