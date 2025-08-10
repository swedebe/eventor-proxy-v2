// GetPersons/GetPersonsRouter.js
// Provides endpoints to update persons for one club or trigger a batch across clubs (without using 'all' in filenames).

const express = require('express');
const router = express.Router();
const { fetchAndStorePersons } = require('./GetPersonsFetcher');
const { runGetPersonsForAllClubs } = require('./GetPersonsRunner');

// Single-club update
router.post('/update-persons', async (req, res) => {
  try {
    const { organisationId } = req.body;
    if (!organisationId || Number.isNaN(Number(organisationId))) {
      return res.status(400).json({ success: false, error: 'organisationId is required and must be a number' });
    }
    const result = await fetchAndStorePersons(Number(organisationId));
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('[GetPersonsRouter] Error in /update-persons:', err?.message);
    return res.status(500).json({ success: false, error: err?.message || 'Internal error' });
  }
});

// Batch-across-clubs (kept under a clear route name, no "all" in filenames)
router.post('/update-persons-batch', async (req, res) => {
  try {
    const { pauseMs, onlyTheseOrganisationIds } = req.body || {};
    const result = await runGetPersonsForAllClubs({ pauseMs, onlyTheseOrganisationIds });
    res.status(result.success ? 200 : 500).json({ success: result.success, ...result });
  } catch (err) {
    console.error('[GetPersonsRouter] Error in /update-persons-batch:', err?.message);
    return res.status(500).json({ success: false, error: err?.message || 'Internal error' });
  }
});

module.exports = router;
