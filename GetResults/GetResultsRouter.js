const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const fetchResultsForEvent = require('./GetResultsFetcher.js');
const { insertLogData } = require('./logHelpersGetResults.js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

router.get('/api/runGetResults', async (req, res) => {
  console.log('[GetResultsRouter] Startar körning av resultatuppdatering');

  const { data: clubs, error: clubError } = await supabase
    .from('clubs')
    .select('organisationid, apikey')
    .not('apikey', 'is', null);

  if (clubError) {
    console.error('[GetResultsRouter] Fel vid hämtning av klubbar:', clubError.message);
    res.status(500).json({ error: 'Fel vid hämtning av klubbar' });
    return;
  }

  const organisationIds = clubs.map(c => c.organisationid);
  console.log('[GetResultsRouter] Klubbar att köra:', organisationIds.join(', '));

  for (const club of clubs) {
    const organisationId = club.organisationid;
    console.log(`[GetResultsRouter] Kör fetchResultsForClub för organisationid=${organisationId}`);
    console.log(`[GetResults] === START club ${organisationId} ===`);

    // Skapa batchrun
    const { data: batch, error: batchError } = await supabase
      .from('batchrun')
      .insert({
        clubparticipation: organisationId,
        comment: 'GetResults',
        status: 'started',
        initiatedby: 'manual',
        appversion: 'v1',
        starttime: new Date().toISOString()
      })
      .select()
      .single();

    if (batchError) {
      console.error(`[GetResults] Fel vid skapande av batchrun:`, batchError.message);
      continue;
    }

    const batchid = batch.id;

    const { data: eventList, error: eventError } = await supabase
      .from('results')
      .select('eventid')
      .eq('clubparticipation', organisationId)
      .order('eventid', { ascending: true });

    if (eventError) {
      console.error(`[GetResults] Fel vid hämtning av events:`, eventError.message);
      await insertLogData(supabase, {
        source: 'GetResultsRouter',
        level: 'error',
        message: `Fel vid hämtning av events: ${eventError.message}`,
        organisationid: organisationId,
        batchid
      });
      continue;
    }

    const uniqueEventIds = [...new Set(eventList.map(e => e.eventid))];

    let antalOk = 0;
    let antalFel = 0;

    for (const eventId of uniqueEventIds) {
      const result = await fetchResultsForEvent({ organisationId, eventId, batchid });
      if (!result) {
        antalFel++;
      } else {
        antalOk++;
      }

      await supabase
        .from('tableupdates')
        .upsert({
          tablename: 'results',
          lastupdated: new Date().toISOString(),
          batchid
        });
    }

    await supabase
      .from('batchrun')
      .update({
        status: 'success',
        endtime: new Date().toISOString(),
        numberofrequests: antalOk + antalFel,
        numberoferrors: antalFel
      })
      .eq('id', batchid);

    console.log(`[GetResults] === SLUT club ${organisationId} ===`);
  }

  console.log('[GetResultsRouter] Klar med alla klubbar');
  res.status(200).json({ message: 'Körning slutförd' });
});

module.exports = router;
