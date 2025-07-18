async function logStart(supabase, anrop) {
  const { data, error } = await supabase
    .from("logdata")
    .insert([{ anrop, startad: new Date().toISOString() }])
    .select()
    .single();

  if (error) throw new Error("Fel vid loggstart: " + error.message);
  return data.id;
}

async function logEnd(supabase, id, resultatkod, felmeddelande) {
  const update = {
    slutförd: new Date().toISOString(),
    resultatkod,
  };
  if (felmeddelande) update.felmeddelande = felmeddelande;

  const { error } = await supabase
    .from("logdata")
    .update(update)
    .eq("id", id);

  if (error) throw new Error("Fel vid loggslut: " + error.message);
}

module.exports = { logStart, logEnd };
