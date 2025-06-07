const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getEventsFromSupabase() {
  const { data, error } = await supabase
    .from("events")
    .select("eventid, eventraceid, eventdate");

  if (error) throw error;
  return data;
}

async function deleteResultsForEvent(organisationId, eventId) {
  const { error } = await supabase
    .from("resultat")
    .delete()
    .match({ TillhörandeOrganisationId: organisationId, EventId: eventId });

  if (error) throw error;
}

async function getPersonMap(organisationId) {
  const { data, error } = await supabase
    .from("personer")
    .select("PersonId, Person_BirthDate, Person_sex")
    .eq("OrganisationId", organisationId);

  if (error) throw error;

  const map = {};
  for (const person of data) {
    map[person.PersonId] = {
      Person_BirthDate: person.Person_BirthDate,
      Person_sex: person.Person_sex,
    };
  }
  return map;
}

async function saveResultsToSupabase(results) {
  if (results.length === 0) return;

  const eventIds = [...new Set(results.map(r => r.EventId))];
  const { data: races, error: raceError } = await supabase
    .from("events")
    .select("eventid, eventraceid")
    .in("eventid", eventIds);

  if (raceError) throw raceError;

  const raceMap = {};
  for (const row of races) {
    raceMap[row.eventid] = row.eventraceid;
  }

  const enriched = results.map(r => ({
    ...r,
    EventRaceId: r.EventRaceId || raceMap[r.EventId] || null,
  }));

  const { error } = await supabase.from("resultat").insert(enriched);
  if (error) throw error;
}

async function logRequest(batchid, anrop, resultatkod = null, felmeddelande = null, id = null, updateEnd = false) {
  const now = new Date().toISOString();

  if (id) {
    const updates = updateEnd
      ? { Slutförd: now, Resultatkod: resultatkod, Felmeddelande: felmeddelande }
      : { Resultatkod: resultatkod, Felmeddelande: felmeddelande };

    const { error } = await supabase
      .from("logdata")
      .update(updates)
      .eq("id", id);

    if (error) throw error;
    return id;
  } else {
    const { data, error } = await supabase
      .from("logdata")
      .insert([{ BatchId: batchid, Startad: now, Anrop: anrop }])
      .select("id")
      .single();

    if (error) throw error;
    return data.id;
  }
}

async function startBatch(id, organisationId, kommentar = "") {
  const now = new Date().toISOString();
  const { error } = await supabase.from("batchkörning").insert([
    {
      ID: id,
      OrganisationId: organisationId,
      Startid: now,
      Status: "running",
      Kommentar: kommentar,
      Skapad_av: "manual",
    },
  ]);
  if (error) throw error;
}

async function endBatch(id, status, kommentar) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("batchkörning")
    .update({
      Sluttid: now,
      Status: status,
      Kommentar: kommentar,
    })
    .eq("ID", id);
  if (error) throw error;
}

module.exports = {
  getEventsFromSupabase,
  deleteResultsForEvent,
  getPersonMap,
  saveResultsToSupabase,
  logRequest,
  startBatch,
  endBatch,
};
