const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { getEventsFromSupabase } = require("../src/supabaseClient");

router.post("/update-events", async (req, res) => {
  const batchid = uuidv4();
  console.log("TEST: /update-events anropades korrekt");

  try {
    const events = await getEventsFromSupabase();
    console.log("TEST: Hämtade", events.length, "events från Supabase");
    res.json({ message: "Supabase OK", antal: events.length, batchid });
  } catch (err) {
    console.error("Supabase FEL:", err);
    res.status(500).json({ error: "Supabase error", details: err.message });
  }
});

module.exports = router;
