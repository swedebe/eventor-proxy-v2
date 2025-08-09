// GetEvents/GetEventsLogger.js
// Centraliserad loggning för GetEvents – enhetligt med GetResults, sätter alltid timestamp/start/completed/status.

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function nowIso() {
  return new Date().toISOString();
}

async function insertLogData(payload) {
  const row = {
    source: payload.source ?? "GetEvents",
    level: payload.level ?? "info",
    organisationid: payload.organisationid ?? null,
    eventid: payload.eventid ?? null,
    batchid: payload.batchid ?? null,
    request: payload.request ?? null,
    response: payload.response ?? null,
    errormessage: payload.errormessage ?? null,
    comment: payload.comment ?? null,
    responsecode: payload.responsecode ?? null,
    timestamp: nowIso(),
    started: payload.started ?? nowIso(),
  };

  const { data, error } = await supabase.from("logdata").insert(row).select().single();
  if (error) {
    console.error("[GetEventsLogger] insertLogData error:", error.message, row);
    return null;
  }
  return data;
}

async function logApiStart(requestUrl, batchid, meta = {}) {
  const row = {
    source: meta.source ?? "GetEventsFetcher",
    level: "info",
    batchid,
    organisationid: meta.organisationid ?? null,
    eventid: meta.eventid ?? null,
    request: requestUrl,
    timestamp: nowIso(),
    started: nowIso(),
    comment: meta.comment ?? null,
  };

  const { data, error } = await supabase.from("logdata").insert(row).select().single();
  if (error) {
    console.error("[GetEventsLogger] logApiStart error:", error.message, row);
    return null;
  }
  return data.id;
}

async function logApiEnd(id, statusCode = 200, responseSnippet = null) {
  if (!id) return;
  const { error } = await supabase
    .from("logdata")
    .update({
      completed: nowIso(),
      responsecode: statusCode,
      response: responseSnippet,
      timestamp: nowIso(),
    })
    .eq("id", id);
  if (error) {
    console.error("[GetEventsLogger] logApiEnd error:", error.message, { id, statusCode });
  }
}

async function logApiError(idOrError, statusCodeOrMsg, message, requestUrl) {
  const now = nowIso();
  let id = null;
  let statusCode = null;
  let errMsg = message ?? null;

  if (typeof idOrError === "string") {
    id = idOrError;
    statusCode = typeof statusCodeOrMsg === "number" ? statusCodeOrMsg : -1;
    if (!errMsg && typeof statusCodeOrMsg === "string") errMsg = statusCodeOrMsg;
  } else {
    // idOrError är ett Error-objekt
    const err = idOrError;
    statusCode = err?.response?.status ?? -1;
    if (!errMsg) errMsg = err?.message ?? "error";
  }

  if (id) {
    const { error } = await supabase
      .from("logdata")
      .update({
        completed: now,
        responsecode: statusCode,
        errormessage: errMsg,
        timestamp: now,
        request: requestUrl ?? null,
      })
      .eq("id", id);
    if (error) console.error("[GetEventsLogger] logApiError update error:", error.message);
    return id;
  }

  const row = {
    source: "GetEventsFetcher",
    level: "error",
    request: requestUrl ?? null,
    responsecode: statusCode,
    errormessage: errMsg,
    timestamp: now,
    started: now,
    completed: now,
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
