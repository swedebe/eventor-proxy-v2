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

module.exports = {
  supabase,
  getEventsFromSupabase,
};
