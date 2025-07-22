const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { logApiCall } = require('./GetEventsLogger');
const { parseStringPromise } = require('xml2js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const EVENTOR_API_BASE = 'https://eventor.orientering.se/api';

async function fetchAndStoreEvents(organisationId) {
  const initiatedBy = 'manual';
  const appVersion = null;
  const renderJobId = null;
  const comment = 'Hämtning av events';

  const { data: batchData, error: batchError } = await supabase
    .from('batchrun')
    .insert([
      {
        organisationid: organisationId,
        starttime: new Date().toISOString(),
        status: 'running',
        comment,
        numberofrequests: 1,
        initiatedby: initiatedBy,
        renderjobid: renderJobId,
        appversion: appVersion,
      },
    ])
    .select()
    .single();

  if (batchError || !batchData?.id) {
    throw new Error('Kunde inte skapa batchrun');
  }

  const batchId = batchData.id;

  const { data: club, error: clubError } = await supabase
    .from('clubs')
    .select('apikey')
    .eq('organisationid', organisationId)
    .single();

  if (clubError || !club?.apikey) {
    throw new Error('API-nyckel saknas för angiven organisation');
  }

  const apiKey = club.apikey;

  const today = new Date();
  const fromDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fromDateStr = `${fromDate.toISOString().split('T')[0]} 00:00:00`;
  const toDateStr = `${today.toISOString().split('T')[0]} 23:59:59`;

  const url = `${EVENTOR_API_BASE}/events?fromDate=${encodeURIComponent(
    fromDateStr
  )}&toDate=${encodeURIComponent(toDateStr)}&classificationIds=1,2,3,6&EventStatusId=3`;

  const log = await logApiCall({ request: url });

  let xml;
  let numberOfErrors = 0;

  try {
    const response = await axios.get(url, {
      headers: { ApiKey: apiKey },
    });

    console.log('Eventor response status:', response.status);
    xml = response.data;

    await supabase
      .from('logdata')
      .update({
        responsecode: '200 OK',
        completed: new Date().toISOString(),
      })
      .eq('id', log.id);
  } catch (err) {
    numberOfErrors = 1;

    await supabase
      .from('logdata')
      .update({
        responsecode: err.response?.status || 'ERR',
        errormessage: err.message,
        completed: new Date().toISOString(),
      })
      .eq('id', log.id);

    await supabase
      .from('batchrun')
      .update({
        endtime: new Date().toISOString(),
        status: 'failed',
        comment: `Fel vid anrop till Eventor: ${err.message}`,
        numberoferrors: numberOfErrors,
      })
      .eq('id', batchId);

    throw err;
  }

  const result = await parseStringPromise(xml);

  const events = (result.EventList?.Event || []).flatMap((event) => {
    const eventid = parseInt(event.EventId?.[0]);
    const eventnameBase = event.Name?.[0];
    const eventorganiser = (event.Organisers?.[0]?.Organiser || [])
      .map((o) => o.Organisation?.[0]?.Name?.[0])
      .filter(Boolean)
      .join(',');
    const eventclassificationid = parseInt(event.EventClassificationId?.[0]);
    const eventform = event.$?.eventForm || null;

    const races = Array.isArray(event.EventRace)
      ? event.EventRace
      : [event.EventRace];
    if (!races || !races[0]) return [];

    return races.map((race) => {
      const eventraceid = parseInt(race.EventRaceId?.[0]);
      const racename = race.Name?.[0] || '';
      const eventdate = race.RaceDate?.[0]?.Date?.[0] || race.EventDate?.[0];
      const eventdistance = race.WRSInfo?.[0]?.Distance?.[0] || null;

      const fullEventName =
        eventform === 'IndMultiDay' ? `${eventnameBase} – ${racename}` : eventnameBase;

      return {
        eventid,
        eventraceid,
        eventdate,
        eventname: fullEventName,
        eventorganiser,
        eventclassificationid,
        eventdistance,
        eventform,
        batchid: batchId,
      };
    });
  });

  console.log("[GetEvents] Antal events att spara:", events.length);
  if (events.length > 0) {
    console.log("[GetEvents] Första radens data:", events[0]);
  } else {
    console.warn("[GetEvents] Inga events hittades i Eventor-svaret.");
  }

  const inserted = [];
  for (const e of events) {
    const { error } = await supabase
      .from('events')
      .upsert(e, { onConflict: 'eventraceid' });

    if (!error) {
      inserted.push(e);
    } else {
      numberOfErrors++;
      console.error(`[GetEvents] Fel vid insert av eventraceid=${e.eventraceid}:`, error.message);
    }
  }

  await supabase
    .from('batchrun')
    .update({
      endtime: new Date().toISOString(),
      status: numberOfErrors === 0 ? 'success' : 'partial',
      numberoferrors: numberOfErrors,
    })
    .eq('id', batchId);

  if (inserted.length > 0) {
    await supabase
      .from('tableupdates')
      .upsert(
        {
          tablename: 'events',
          lastupdated: new Date().toISOString(),
          updatedbybatchid: batchId,
        },
        { onConflict: 'tablename' }
      );
  }

  console.log(`[GetEvents] Inserted ${inserted.length} events to Supabase`);
  return { insertedCount: inserted.length };
}

module.exports = { fetchAndStoreEvents };
