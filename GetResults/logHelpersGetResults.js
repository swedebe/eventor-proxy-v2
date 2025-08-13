// GetResults/logHelpersGetResults.js
// Centralized logging for GetResults with robust error capture.
// IMPORTANT: The 'logdata' table does NOT have a 'response' column – use 'comment' for snippets.
// Always set: timestamp, started, and (on end/error) completed + responsecode.
//
// Env is read from Render: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// No .env usage per project rules.

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Toggle verbose console logging without changing DB schema
const DEBUG = process.env.DEBUG_LOGHELPERS === "1";

// ---- Helpers ---------------------------------------------------------------

function getClient(potentialClient) {
  if (potentialClient && typeof potentialClient.from === "function") {
    return potentialClient;
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

function nowIso() {
  return new Date().toISOString();
}

function truncate(str, n = 2000) {
  if (str == null) return null;
  const s = String(str);
  return s.length <= n ? s : s.slice(0, n);
}

// Try to extract as much error detail as possible (axios, fetch, generic)
function getErrorDetails(err) {
  // Default fallbacks
  let status = null;
  let message = null;
  let bodySnippet = null;

  // Axios-like error
  if (err && typeof err === "object") {
    // status
    status = err?.response?.status ?? err?.status ?? null;

    // message
    message =
      err?.response?.statusText ||
      err?.message ||
      (typeof err === "string" ? err : null) ||
      "Unknown error";

    // response body (try various shapes)
    const data = err?.response?.data ?? err?.data ?? null;
    if (data != null) {
      try {
        if (typeof data === "string") {
          bodySnippet = truncate(data);
        } else if (typeof data === "object") {
          bodySnippet = truncate(JSON.stringify(data));
        } else {
          bodySnippet = truncate(String(data));
        }
      } catch {
        bodySnippet = truncate(String(data));
      }
    }

    // Special case: some libs put body text on err.body or err.text
    if (!bodySnippet && (err.body || err.text)) {
      bodySnippet = truncate(err.body || err.text);
    }
  } else if (typeof err === "string") {
    // Plain string error
    message = err;
  }

  // If nothing detected, force some content
  if (status == null) status = -1;
  if (!message) message = "error";

  return { status, message, bodySnippet };
}

function safeConsole(...args) {
  if (DEBUG) console.log(...args);
}

// ---- Core API --------------------------------------------------------------

/**
 * insertLogData([supabase], payload)
 * payload:
 *  - source, level, organisationid, eventid, batchid, request,
 *    errormessage, comment, responsecode, started, completed
 * Always sets: timestamp and started (if missing)
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
    comment: truncate(payload.comment ?? null),
    responsecode: payload.responsecode ?? null,
    timestamp: nowIso(),
    started: payload.started ?? nowIso(),
    completed: payload.completed ?? null,
  };

  const { data, error } = await supabase
    .from("logdata")
    .insert(row)
    .select()
    .single();

  if (error) {
    console.error("[logHelpersGetResults] insertLogData error:", error.message, row);
    return null;
  }
  return data;
}

/**
 * logApiStart(requestUrl, batchid, meta?)
 * Returns id of created log row (or null on failure).
 */
async function logApiStart(requestUrl, batchid, meta = {}) {
  const supabase = getClient();
  const row = {
    source: meta.source ?? "GetResultsFetcher",
    level: meta.level ?? "info",
    batchid,
    organisationid: meta.organisationid ?? null,
    eventid: meta.eventid ?? null,
    request: requestUrl ?? null,
    comment: truncate(meta.comment ?? null),
    timestamp: nowIso(),
    started: nowIso(),
  };

  const { data, error } = await supabase
    .from("logdata")
    .insert(row)
    .select()
    .single();

  if (error) {
    console.error("[logApiStart] insert error:", error.message, row);
    return null;
  }
  return data.id;
}

/**
 * logApiEnd(id, statusCode=200, note=null)
 * Sets completed + responsecode. 'note' goes to comment.
 */
async function logApiEnd(id, statusCode = 200, note = null) {
  if (!id) return;
  const supabase = getClient();
  const patch = {
    completed: nowIso(),
    responsecode: statusCode,
    timestamp: nowIso(),
  };
  if (note != null) patch.comment = truncate(String(note));

  const { error } = await supabase.from("logdata").update(patch).eq("id", id);
  if (error) {
    console.error("[logApiEnd] update error:", error.message, { id, statusCode });
  }
}

/**
 * logApiError(idOrMeta, statusOrError, message?, requestUrl?)
 * Usage:
 *  - logApiError(existingId, statusCodeOrError, message?, url?)  // updates existing row
 *  - logApiError(null, statusCodeOrError, message?, url?)        // creates new error row
 *
 * Guarantees set: completed, responsecode, errormessage (and optionally request, comment)
 */
async function logApiError(idOrMeta, statusOrError, message, requestUrl) {
  const supabase = getClient();
  const now = nowIso();

  // Normalize to a status + message + optional snippet
  let statusCode = null;
  let errorMessage = message ?? null;
  let snippet = null;

  if (statusOrError && typeof statusOrError === "object") {
    const det = getErrorDetails(statusOrError);
    statusCode = det.status;
    if (!errorMessage) errorMessage = det.message;
    snippet = det.bodySnippet;
  } else {
    // number or string
    if (typeof statusOrError === "number") statusCode = statusOrError;
    if (typeof statusOrError === "string" && !errorMessage) errorMessage = statusOrError;
    if (statusCode == null) statusCode = -1;
  }

  if (idOrMeta) {
    // === MINIMAL FIX 1: se till att errormessage aldrig blir tomt i update-fallet
    if (!errorMessage) { errorMessage = (typeof statusOrError === "number") ? `HTTP ${statusOrError}` : "Unspecified error"; }

    const patch = {
      completed: now,
      responsecode: statusCode,
      errormessage: truncate(errorMessage),
      level: "error",            // === MINIMAL FIX 2: markera nivån som error även vid update
      timestamp: now,
    };
    if (requestUrl) patch.request = requestUrl;
    if (snippet) {
      // keep existing comment and append snippet safely on the DB side is tricky;
      // here we just set/overwrite with the snippet if provided
      patch.comment = truncate(snippet);
    }

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
    errormessage: truncate(errorMessage),
    comment: truncate(snippet),
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

/**
 * logDbError({ batchid?, organisationid?, eventid? }, error, contextNote?)
 * Records database-related errors (e.g., unique constraint violations).
 * responsecode is set to 'DB_ERROR' to distinguish from HTTP errors.
 */
async function logDbError(meta = {}, errorObj, contextNote) {
  const supabase = getClient();
  const now = nowIso();
  const { message } = getErrorDetails(errorObj);
  const row = {
    source: "DB",
    level: "error",
    batchid: meta.batchid ?? null,
    organisationid: meta.organisationid ?? null,
    eventid: meta.eventid ?? null,
    request: meta.request ?? null,
    responsecode: "DB_ERROR",
    errormessage: truncate(message),
    comment: truncate(contextNote ?? null),
    timestamp: now,
    started: now,
    completed: now,
  };

  const { error } = await supabase.from("logdata").insert(row);
  if (error) {
    console.error("[logDbError] insert error:", error.message, row);
    return null;
  }
  return true;
}

// Optional convenience info/warn/debug (DB-level)
async function logInfo(payload) {
  return insertLogData({ ...payload, level: "info" });
}
async function logWarn(payload) {
  return insertLogData({ ...payload, level: "warn" });
}
async function logDebug(payload) {
  if (!DEBUG) return null;
  return insertLogData({ ...payload, level: "debug" });
}

module.exports = {
  insertLogData,
  logApiStart,
  logApiEnd,
  logApiError,
  logDbError,
  logInfo,
  logWarn,
  logDebug,
};
