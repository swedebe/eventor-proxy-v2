const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EVENTOR_API_KEY = process.env.EVENTOR_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Testanrop som loggar till tabellen logdata
router.post("/batch/test-eventor-anrop", async (req, res) => {
  const organisationId = req.body.organisationId;
  if (!organisationId) {
    return res.status(400).json({ error: "organisationId saknas" });
  }

  const batchid = uuidv4();
  const eventorUrl = `https://eventor.orientering.se/api/events?organisationId=${organisationId}&classificationIds=1,2,3,6`;

  // Logg: start
  const { error: logStartError } = await supabase.from("logdata").insert({
    batchid,
    started: new Date().toISOString(),
    request: eventorUrl
  });

  if (logStartError) {
    console.error("Kunde inte logga start:", logStartError);
    return res.status(500).json({ error: "Fel vid loggstart" });
  }

  try {
    const response = await axios.get(eventorUrl, {
      headers: {
        ApiKey: EVENTOR_API_KEY,
        Accept: "application/xml"
      },
      timeout: 15000
    });

    const responsecode = `${response.status} ${response.statusText}`;

    // Logg: slutförd
    const { error: logCompleteError } = await supabase.from("logdata").update({
      completed: new Date().toISOString(),
      responsecode
    }).eq("batchid", batchid);

    if (logCompleteError) {
      console.error("Kunde inte logga slutförande:", logCompleteError);
    }

    return res.status(200).json({
      message: "Anrop genomfört och loggat",
      responsecode,
      data: response.data
    });

  } catch (error) {
    let responsecode = "N/A";
    let errormessage = error.message;

    if (error.response) {
      responsecode = `${error.response.status} ${error.response.statusText}`;
      errormessage = typeof error.response.data === "string"
        ? error.response.data.slice(0, 500)
        : JSON.stringify(error.response.data).slice(0, 500);
    }

    // Logg: fel
    const { error: logError } = await supabase.from("logdata").update({
      completed: new Date().toISOString(),
      responsecode,
      errormessage
    }).eq("batchid", batchid);

    if (logError) {
      console.error("Kunde inte logga fel:", logError);
    }

    return res.status(500).json({
      error: "Fel vid anrop till Eventor",
      responsecode,
      errormessage
    });
  }
});

module.exports = router;
