const express = require("express");
const router = express.Router();
const { createClient } = require("@supabase/supabase-js");
const { fetchResultsForClub } = require("./GetResultsFetcher");

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log("[GetResultsRouter] Initierar Supabase-klient");
console.log("[GetResultsRouter] SUPABASE_URL:", supabaseUrl);
console.log("[GetResultsRouter] SUPABASE_SERVICE_ROLE_KEY finns:", !!serviceKey);

const supabase = createClient(supabaseUrl, serviceKey);

router.get("/runGetResults", async (req, res) => {
  try {
    console.log("[GetResultsRouter] Startar körning av resultatuppdatering");

    const { data: clubs, error } = await supabase
      .from("clubs")
      .select("organisationid, apikey");

    if (error) {
      console.error("[GetResultsRouter] Fel vid hämtning av klubbar:", error.message);
      throw new Error(error.message);
    }

    if (!clubs || clubs.length === 0) {
      console.warn("[GetResultsRouter] Inga klubbar hittades i tabellen clubs");
      throw new Error("Inga klubbar hittades i tabellen clubs");
    }

    console.log("[GetResultsRouter] Klubbar att köra:", clubs.map(c => c.organisationid).join(", "));

    for (const club of clubs) {
      try {
        console.log(`[GetResultsRouter] Kör fetchResultsForClub för organisationid=${club.organisationid}`);
        await fetchResultsForClub(supabase, club.organisationid, club.apikey);
        console.log(`[GetResultsRouter] Klar med organisationid=${club.organisationid}`);
      } catch (innerErr) {
        console.error(`[GetResultsRouter] Fel i fetchResultsForClub för organisationid=${club.organisationid}:`, innerErr.stack || innerErr.message);
      }
    }

    console.log("[GetResultsRouter] Klar med alla klubbar");
    res.status(200).json({ message: "Resultatuppdatering slutförd" });
  } catch (err) {
    console.error("[GetResultsRouter] Fel i runGetResults:", err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
