const express = require("express");
const router = express.Router();
const fetchResultsForClub = require("./GetResultsFetcher"); // Ändrat här
const { createClient } = require("@supabase/supabase-js");
const { insertLogData } = require("../shared/logHelpers");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

router.post("/getresults", async (req, res) => {
  console.log("[GetResultsRouter] Startar körning av resultatuppdatering");

  const orgIds = req.body.organisationids;
  if (!orgIds || !Array.isArray(orgIds)) {
    return res.status(400).json({ error: "organisationids krävs som array" });
  }

  console.log("[GetResultsRouter] Klubbar att köra:", orgIds.join(", "));

  for (const organisationid of orgIds) {
    console.log(`[GetResultsRouter] Kör fetchResultsForClub för organisationid=${organisationid}`);
    try {
      await fetchResultsForClub({ organisationId: organisationid });
    } catch (error) {
      console.error(`[GetResultsRouter] Fel vid körning för klubb ${organisationid}:`, error);
      await insertLogData(supabase, {
        source: "GetResultsRouter",
        level: "error",
        message: `Fel vid körning för klubb ${organisationid}: ${error.message}`,
        organisationid: organisationid,
        eventid: null,
        batchid: null,
      });
    }
    console.log(`[GetResultsRouter] Klar med organisationid=${organisationid}`);
  }

  console.log("[GetResultsRouter] Klar med alla klubbar");
  res.status(200).json({ status: "klar" });
});

module.exports = router;
