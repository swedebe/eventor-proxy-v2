const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const fetchResultsForEvent = require('./GetResultsFetcher.js');
const { insertLogData } = require('./logHelpersGetResults.js');

const router = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

router.get('/runGetResults', async (req, res) => {
  console.log('[GetResultsRouter] Startar körning av resultatuppdatering');

  const { data: clubs, error: clubsError } = await supabase
    .from('clubs')
    .select('organisationid')
    .not('apikey', 'is', null);

  if (clubsError) {
    console.error('[GetResultsRouter] Fel vid hämtning av klubbar:', clubsError.message);
    return res.status(500).send('Fel vid hämtning av klubbar');
  }

  const organisationIds = clubs.map(c => c.organisationid);
  console.log('[GetResultsRouter] Klubbar att köra:', organisationIds.join(', '));

  for (const organisationId of organisationIds) {
    console.log(`[GetResultsRouter] Kör fetchResultsForClub för organisationid=${organisationId}`);
    await runForClub(organisationId);
  }

  console.log('[GetResultsRouter] Klar med alla klubbar');
  res.status(200).send('Körning slutförd');
});

async function runForClub(organisationId) {
  console.log(`[GetResults] === START club ${organisationId} ===`);

  const start = new Date().toISOString();
  const { data: batch, error: batchError } = await supabase
    .from('batchrun')
    .insert({
      organisationid: organisationId,
      starttime: start,
      comment: 'GetResults',
      status: 'running',
      initiatedby: 'manual',
      appversion: 'v1'
    })
    .select()
    .single();

  if (batchError) {
    console.error('[GetResults] Fel vid skapande av batchrun:', batchError.message);
    return;
  }

  const batchid = batch.id;
  console.log(`[GetResults] Skapade batchrun med id ${batchid}`);

  const { data: eventOrgs, error: eventsError } = await supabase
    .from('eventorganisations')
    .select('eventid')
    .eq('organisationid', organisationId);

  if (eventsError) {
    console.error('[GetResults] Fel vid hämtning av eventorganisations:', eventsError.message);
    await insertLogData(supabase, {
      source: 'GetResultsRouter',
      level: 'error',
      message: `Fel vid hämtning av eventorganisations: ${eventsError.message}`,
      organisationid: organisationId,
      batchid
    });
    return;
  }

  const eventIds = eventOrgs.map(e => e.eventid);

  for (const eventid of eventIds) {
    const { data: eventData, error: eventError } = await supabase
      .from('events')
      .select('eventraceid')
      .eq('eventid', eventid)
      .maybeSingle();

    if (eventError || !eventData?.eventraceid) {
      console.warn(`[GetResults] Hoppar över event ${eventid} – kunde inte hämta eventraceid`);
      continue;
    }

    await fetchResultsForEvent({
      organisationId,
      eventId: eventid,
      batchid
    });

    const now = new Date().toISOString();
    await supabase
      .from('tableupdates')
      .upsert({
        tablename: 'results',
        lastupdated: now,
        batchid
      });
  }

  const end = new Date().toISOString();
  await supabase
    .from('batchrun')
    .update({ endtime: end, status: 'success' })
    .eq('id', batchid);

  console.log(`[GetResults] Batchrun ${batchid} uppdaterad`);
  console.log(`[GetResults] === SLUT club ${organisationId} ===`);
}

module.exports = router;
