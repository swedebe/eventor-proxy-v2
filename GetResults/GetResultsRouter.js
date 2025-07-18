const express = require("express");
const router = express.Router();
const { createClient } = require("@supabase/supabase-js");
const { fetchResultsForClub } = require("./GetResultsFetcher");

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, serviceKey);

router.get("/runGetResults", async (req, res) => {
  try {
    const { data: clubs, error } = await supabase
      .from("clubs")
      .select("organisationid, apikey");

    if (error) throw new Error(error.message);

    for (const club of clubs) {
      await fetchResultsForClub(supabase, club.organisationid, club.apikey);
    }

    res.status(200).json({ message: "Resultatuppdatering slutförd" });
  } catch (err) {
    console.error("Fel i runGetResults:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
