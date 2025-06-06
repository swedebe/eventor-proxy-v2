const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Test-endpoint
router.get("/test-eventor-anrop", async (req, res) => {
  try {
    const { error } = await supabase.from("testlog").insert({
      message: "Render can write!",
    });

    if (error) {
      console.error("Fel vid insert i testlog:", error);
      return res.status(500).json({ message: "Fel vid insert i testlog", error });
    }

    res.status(200).send("OK – testlog försökt");
  } catch (err) {
    console.error("Allmänt fel i testanrop:", err);
    res.status(500).send("Något gick fel");
  }
});

module.exports = router;
