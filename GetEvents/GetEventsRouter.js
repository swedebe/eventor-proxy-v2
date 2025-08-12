const express = require('express');
const { fetchAndStoreEvents } = require('./GetEventsFetcher');

const router = express.Router();

// Gemensam hanterare för både POST och GET /update-events. Tar emot organisationId
// samt valfria fromDate, toDate och classificationIds. Dessa parametrar kan
// skickas i JSON-body (POST) eller som query-parametrar (GET). Om
// organisationId saknas returneras status 400.
async function handleUpdateEvents(req, res) {
  try {
    // organisationId krävs alltid
    const organisationId = req.body?.organisationId ?? req.query?.organisationId;
    if (!organisationId) {
      return res.status(400).json({ error: 'organisationId is required' });
    }

    // Läs tidsparametrar och klassificeringar från body eller query
    const fromDate = req.body?.fromDate ?? req.query?.fromDate ?? null;
    const toDate = req.body?.toDate ?? req.query?.toDate ?? null;
    let classificationIds = req.body?.classificationIds ?? req.query?.classificationIds ?? null;
    if (typeof classificationIds === 'string') {
      // Om query param är sträng, splitta på komma till array av siffror
      classificationIds = classificationIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((n) => parseInt(n));
    }

    const options = {};
    if (fromDate) options.fromDate = fromDate;
    if (toDate) options.toDate = toDate;
    if (Array.isArray(classificationIds)) options.classificationIds = classificationIds;

    const result = await fetchAndStoreEvents(organisationId, options);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('Error in /update-events route:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

router.post('/update-events', handleUpdateEvents);
router.get('/update-events', handleUpdateEvents);

module.exports = router;
