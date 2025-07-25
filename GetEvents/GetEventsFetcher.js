const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { logApiCallSimple } = require('./GetEventsLogger');
const { parseStringPromise } = require('xml2js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const EVENTOR_API_BASE = 'https://eventor.orientering.se/api';

async function fetchAndStoreEvents(organisationId) {
  const initiatedBy = 'manual';
  const appVersion = null;
  const renderJobId = process.env.RENDER_JOB_ID || null;
  const comment = 'Hämtning av events';

  console.log('[GetEvents] Initierar batchrun med organisationId:', organisationId);

  const { count: beforeCount } = await supabase
    .from('events')
    .select('*', { count: 'exact', head: true });

  const { data: batchData, error: batchError } = await supabase
    .from('batchrun')
    .insert([
      {
        clubparticipation: organisationId,
        starttime: new Date().toISOString(),
        status: 'running',
        comment,
        numberofrequests: 1,
        initiatedby: initiatedBy,
        renderjobid: renderJobId,
        appversion: appVersion,
        numberofrowsbefore: beforeCount || 0,
      },
    ])
    .select()
    .single();

  if (batchError || !batchData?.id) {
    console.error('[GetEvents] Fel vid skapande av batchrun:', batchError);
    throw new Error('Kunde inte skapa batchrun');
  }

  const batchId = batchData.id;
  console.log('[GetEvents] Skapade batchrun med ID:', batchId);

  const { data: club, error: clubError } = await supabase
    .from('clubs')
    .select('apikey')
    .eq('organisationid', organisationId)
    .single();

  if (clubError || !club?.apikey) {
    console.error('[GetEvents] Saknar API-nyckel för organisationId:', organisationId);
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

  const log = await logApiCallSimple({ request: url });

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
    console.error('[GetEvents] Fel vid anrop till Eventor:', err.message);

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

  const { data: eventorclubs, error: lookupError } = await supabase
    .from('eventorclubs')
    .select('organisationid, clubname');

  if (lookupError) {
    console.error('[GetEvents] Kunde inte hämta eventorclubs:', lookupError);
    throw new Error('Kunde inte hämta klubbnamn från eventorclubs');
  }

  const clubMap = Object.fromEntries(eventorclubs.map(c => [String(c.organisationid), c.clubname]));

  const events = (result.EventList?.Event || []).flatMap((event) => {
    const eventid = parseInt(event.EventId?.[0]);
    const eventnameBase = event.Name?.[0];
    const organiserIds = (event.Organiser?.[0]?.OrganisationId || [])
      .map((orgId) => orgId?._ || orgId)
      .filter(Boolean);

    const organiserNames = organiserIds
      .map((id) => clubMap[String(id)] || `Organisation ${id}`)
      .join(', ');

    const eventorganiser_ids = organiserIds.join(',');
    const eventorganiser_names = organiserNames;

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
        eventorganiser: eventorganiser_names,
        eventorganiser_ids,
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

  const { count: afterCount } = await supabase
    .from('events')
    .select('*', { count: 'exact', head: true });

  await supabase
    .from('batchrun')
    .update({
      endtime: new Date().toISOString(),
      status: numberOfErrors === 0 ? 'success' : 'partial',
      numberoferrors: numberOfErrors,
      numberofrowsafter: afterCount || 0,
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
