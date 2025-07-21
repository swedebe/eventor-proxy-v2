const express = require('express');
const { fetchAndStoreEvents } = require('./GetEventsFetcher');

const router = express.Router();

router.post('/update-events', async (req, res) => {
  try {
    const { organisationId } = req.body;
    if (!organisationId) {
      return res.status(400).json({ error: 'organisationId is required' });
    }

    const result = await fetchAndStoreEvents(organisationId);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('Error in /update-events route:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
