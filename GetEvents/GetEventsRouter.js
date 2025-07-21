const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { fetchEventsFromEventor } = require('./GetEventsFetcher');
const { logToDatabase } = require('./GetEventsLogger');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

router.post('/getevents', async (req, res) => {
  const batchStart = new Date().toISOString();
  let numberOfRequests = 0;
  let numberOfErrors = 0;
  let anySuccessfulInsert = false;

  const initiatedBy = req.body.initiatedBy || 'manual';
  const appversion = req.body.appversion || null;

  const { data: batchInserted, error: batchInsertError } = await supabase
    .from('batchrun')
    .insert([{
      starttime: batchStart,
      status: 'running',
      initiatedby: initiatedBy,
      appversion,
      comment: 'Updating events',
    }])
    .select('id')
    .single();

  if (batchInsertError) {
    return res.status(500).json({ error: 'Failed to create batchrun: ' + batchInsertError.message });
  }

  const batchId = batchInserted.id;

  const { data: clubs, error: clubsError } = await supabase.from('clubs').select('organisationid, apikey');
  if (clubsError || !clubs) {
    await supabase.from('batchrun').update({
      endtime: new Date().toISOString(),
      status: 'failed',
      numberoferrors: 1,
      comment: 'Could not fetch clubs'
    }).eq('id', batchId);
    return res.status(500).send('Failed to load clubs from database.');
  }

  for (const club of clubs) {
    const { organisationid, apikey } = club;
    const requestUrl = `https://eventor.orientering.se/api/events`;
    const started = new Date().toISOString();

    const response = await fetchEventsFromEventor(organisationid, apikey);
    const completed = new Date().toISOString();
    numberOfRequests++;

    if (!response.success || !response.data) {
      numberOfErrors++;
      await logToDatabase(requestUrl, started, completed, response.status, response.error || 'Missing data');
      continue;
    }

    const { error: upsertError } = await supabase
      .from('events')
      .upsert(response.data, { onConflict: ['eventraceid'] });

    if (upsertError) {
      numberOfErrors++;
      await logToDatabase(requestUrl, started, completed, 500, upsertError.message);
    } else {
      await logToDatabase(requestUrl, started, completed, 200, null);
      if (response.data.length > 0) anySuccessfulInsert = true;
    }
  }

  const batchEnd = new Date().toISOString();
  const status = numberOfErrors > 0
    ? (numberOfErrors === numberOfRequests ? 'failed' : 'partial')
    : 'success';

  await supabase.from('batchrun').update({
    endtime: batchEnd,
    status,
    numberofrequests: numberOfRequests,
    numberoferrors: numberOfErrors
  }).eq('id', batchId);

  if (anySuccessfulInsert) {
    await supabase.from('tableupdates').upsert([{
      tablename: 'events',
      lastupdated: batchEnd,
      updatedbybatchid: batchId,
    }], { onConflict: ['tablename'] });
  }

  res.status(200).json({
    message: 'Event update batch completed',
    batchId,
    numberOfRequests,
    numberOfErrors,
    status,
  });
});

module.exports = router;
