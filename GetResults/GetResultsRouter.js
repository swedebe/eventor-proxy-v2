const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { fetchResultsFromEventor } = require('./GetResultsFetcher');
const { logToDatabase } = require('./GetResultsLogger');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

router.post('/getresults', async (req, res) => {
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
      comment: 'Updating results',
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

    const { data: recentEvents, error: eventError } = await supabase
      .from('events')
      .select('eventid')
      .gte('eventdate', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order('eventdate', { ascending: false });

    if (eventError || !recentEvents) {
      numberOfErrors++;
      continue;
    }

    for (const event of recentEvents) {
      const eventId = event.eventid;
      const requestUrl = `https://eventor.orientering.se/api/results/organisation?organisationIds=${organisationid}&eventId=${eventId}`;
      const started = new Date().toISOString();

      const response = await fetchResultsFromEventor(eventId, organisationid, apikey);
      const completed = new Date().toISOString();
      numberOfRequests++;

      if (!response.success || !response.data) {
        numberOfErrors++;
        await logToDatabase(requestUrl, started, completed, response.status, response.error || 'Missing data');
        continue;
      }

      // Radera existerande resultat för kombon organisationid + eventid
      await supabase
        .from('results')
        .delete()
        .eq('organisationid', organisationid)
        .eq('eventid', eventId);

      const { error: insertError } = await supabase
        .from('results')
        .insert(response.data);

      if (insertError) {
        numberOfErrors++;
        await logToDatabase(requestUrl, started, completed, 500, insertError.message);
      } else {
        await logToDatabase(requestUrl, started, completed, 200, null);
        if (response.data.length > 0) anySuccessfulInsert = true;
      }
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
      tablename: 'results',
      lastupdated: batchEnd,
      updatedbybatchid: batchId,
    }], { onConflict: ['tablename'] });
  }

  res.status(200).json({
    message: 'Result update batch completed',
    batchId,
    numberOfRequests,
    numberOfErrors,
    status,
  });
});

module.exports = router;
