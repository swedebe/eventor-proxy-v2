const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const {
  getEventsFromSupabase,
  saveEventsToSupabase,
} = require("../src/supabaseClient");

router.post("/update-events", async (req, res) => {
  const batchid = uuidv4();
  console.log("TEST: /update-events anropades korrekt");

  try {
    const dummy = [
      {
        eventid: 999000 + Math.floor(Math.random() * 1000),
        eventraceid: 999000 + Math.floor(Math.random() * 1000),
        eventdate: new Date().toISOString().split("T")[0],
      },
    ];

    const inserted = await saveEventsToSupabase(dummy, batchid);
    console.log("TEST: Sparade", inserted, "dummy-tävlingar i Supabase");

    res.json({ message: "Dummy insert OK", inserted, batchid });
  } catch (err) {
    console.error("Fel vid saveEventsToSupabase:", err);
    res.status(500).json({ error: "Insert error", details: err.message });
  }
});

module.exports = router;
