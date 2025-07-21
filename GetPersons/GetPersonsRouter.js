const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { parseStringPromise } = require('xml2js');
const { fetchPersonsFromEventor } = require('./GetPersonsFetcher');
const { logToDatabase } = require('./GetPersonsLogger');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

router.post('/getpersons', async (req, res) => {
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
      comment: 'Updating persons',
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
    const requestUrl = `https://eventor.orientering.se/api/persons/organisations/${organisationid}`;
    const started = new Date().toISOString();
    const response = await fetchPersonsFromEventor(organisationid, apikey);
    const completed = new Date().toISOString();
    numberOfRequests++;

    if (response.status !== 200 || !response.data) {
      numberOfErrors++;
      await logToDatabase(requestUrl, started, completed, response.status, response.error || 'Missing data');
      continue;
    }

    try {
      const parsed = await parseStringPromise(response.data);
      const persons = parsed.Persons?.Person || [];

      const rows = persons.map((p) => ({
        organisationid,
        personid: p.PersonId?.[0] || null,
        personnamefamily: p.PersonName?.[0]?.Family || null,
        personnamegiven: p.PersonName?.[0]?.Given || null,
        personsex: p.Sex?.[0] || null,
        personbirthdate: p.BirthDate?.[0] || null,
      }));

      const filtered = rows.filter((row) => row.personid && row.personnamefamily && row.personnamegiven);

      const { error: upsertError } = await supabase
        .from('persons')
        .upsert(filtered, { onConflict: ['organisationid', 'personid'] });

      if (upsertError) {
        numberOfErrors++;
        await logToDatabase(requestUrl, started, completed, 500, upsertError.message);
      } else {
        await logToDatabase(requestUrl, started, completed, 200, null);
        if (filtered.length > 0) anySuccessfulInsert = true;
      }
    } catch (err) {
      numberOfErrors++;
      await logToDatabase(requestUrl, started, completed, 500, err.message);
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
      tablename: 'persons',
      lastupdated: batchEnd,
      updatedbybatchid: batchId,
    }], { onConflict: ['tablename'] });
  }

  res.status(200).json({
    message: 'Person update batch completed',
    batchId,
    numberOfRequests,
    numberOfErrors,
    status,
  });
});

module.exports = router;
