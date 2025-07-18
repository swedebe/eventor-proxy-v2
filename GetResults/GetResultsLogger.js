async function logStart(supabase, request) {
  const { data, error } = await supabase
    .from("logdata")
    .insert([{ request, started: new Date().toISOString() }])
    .select()
    .single();

  if (error) throw new Error("Fel vid loggstart: " + error.message);
  return data.id;
}

async function logEnd(supabase, id, responsecode, errormessage) {
  const update = {
    completed: new Date().toISOString(),
    responsecode,
  };
  if (errormessage) update.errormessage = errormessage;

  const { error } = await supabase
    .from("logdata")
    .update(update)
    .eq("id", id);

  if (error) throw new Error("Fel vid loggslut: " + error.message);
}

module.exports = { logStart, logEnd };
