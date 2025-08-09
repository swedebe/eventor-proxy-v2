// GetResults/logHelpersGetResults.js
// Centraliserad loggning för GetResults. Säkerställer timestamp/started/completed/responsecode alltid sätts.
// Bakåtkompatibel: insertLogData kan anropas med (supabaseClient, payload) ELLER (payload).

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
 * payload-fält som hanteras:
 * - source, level, organisationid, eventid, batchid, request, response, errormessage, comment, responsecode
 * Sätter alltid: timestamp, och om inte satt: started (vid insert).
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
    response: payload.response ?? null,
    errormessage: payload.errormessage ?? null,
    comment: payload.comment ?? null,
    responsecode: payload.responsecode ?? null,
    timestamp: nowIso(),
    started: payload.started ?? nowIso(), // sätt start om ej finns
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
 * returnerar id för loggraden
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
    timestamp: nowIso(),
    started: nowIso(),
    comment: meta.comment ?? null,
  };

  const { data, error } = await supabase.from("logdata").insert(row).select().single();
  if (error) {
    console.error("[logApiStart] insert error:", error.message, row);
    return null;
  }
  return data.id;
}

/**
 * logApiEnd(id, statusCode, responseSnippet?)
 * sätter completed + responsecode (+ optional response)
 */
async function logApiEnd(id, statusCode = 200, responseSnippet = null) {
  if (!id) return;
  const supabase = getClient();
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
    console.error("[logApiEnd] update error:", error.message, { id, statusCode });
  }
}

/**
 * logApiError(idOrMeta, statusCodeOrError, message?, requestUrl?)
 * Flexibel signatur:
 * - logApiError(existingId, statusCode, message, url)
 * - logApiError(null, errorObj, message, url) // skapar ny rad
 */
async function logApiError(idOrMeta, statusCodeOrError, message, requestUrl) {
  const supabase = getClient();
  const now = nowIso();

  // extrahera status
  let statusCode = null;
  let errorMessage = message ?? null;

  if (statusCodeOrError && typeof statusCodeOrError === "object") {
    statusCode = statusCodeOrError?.response?.status ?? -1;
    if (!errorMessage) {
      errorMessage = statusCodeOrError?.message ?? "error";
    }
  } else {
    statusCode = statusCodeOrError ?? -1;
  }

  if (idOrMeta) {
    // uppdatera befintlig rad
    const { error } = await supabase
      .from("logdata")
      .update({
        completed: now,
        responsecode: statusCode,
        errormessage: errorMessage,
        timestamp: now,
        request: requestUrl ?? null,
      })
      .eq("id", idOrMeta);
    if (error) {
      console.error("[logApiError] update error:", error.message, { id: idOrMeta, statusCode });
    }
    return idOrMeta;
  }

  // skapa ny felrad om vi inte har ett id
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
