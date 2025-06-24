const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { getEvents } = require("../src/eventorClient");

router.post("/update-events", async (req, res) => {
  const batchid = uuidv4();
  console.log("TEST: /update-events anropades korrekt");

  const fromDate = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const toDate = new Date().toISOString().split("T")[0];

  try {
    const events = await getEvents(fromDate, toDate);
    console.log("TEST: Hämtade", events.length, "tävlingar från Eventor");
    res.json({ message: "Eventor OK", antal: events.length, batchid });
  } catch (err) {
    console.error("Fel vid getEvents:", err.message || err);
    res.status(500).json({ error: "Eventor error", details: err.message });
  }
});

module.exports = router;
