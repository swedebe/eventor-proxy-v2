const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");

// En enkel test-endpoint för felsökning
router.post("/update-events", async (req, res) => {
  const batchid = uuidv4();
  console.log("TEST: /update-events anropades korrekt");
  res.json({ message: "Update-events test kördes", batchid });
});

router.post("/update-results", async (req, res) => {
  const batchid = uuidv4();
  console.log("TEST: /update-results anropades korrekt");
  res.json({ message: "Update-results test kördes", batchid });
});

module.exports = router;
