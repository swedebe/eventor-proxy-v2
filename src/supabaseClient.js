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

// Lägg in dummy-tävlingar i Supabase
async function saveEventsToSupabase(events, batchid) {
  const formatted = events.map(e => ({
    eventid: e.eventid,
    eventraceid: e.eventraceid,
    eventdate: e.eventdate,
    batchid,
  }));

  const { error } = await supabase.from("events").insert(formatted);
  if (error) throw error;

  return formatted.length;
}

module.exports = {
  supabase,
  getEventsFromSupabase,
  saveEventsToSupabase,
};
