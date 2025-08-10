const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { logApiStart, logApiEnd, logApiError } = require('./GetEventsLogger');
const { parseStringPromise } = require('xml2js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const EVENTOR_API_BASE = 'https://eventor.orientering.se/api';

async function fetchAndStoreEvents(organisationId) {
  const initiatedBy = 'manual';
  const appVersion = null;
  const renderJobId = process.env.RENDER_INSTANCE_ID || null;
  const comment = 'Hämtning av events';

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

  // Hämta API‑nyckel för klubben
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

  // Datumintervall: 30 dagar bakåt t.o.m. idag
  const today = new Date();
  const fromDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fromDateStr = `${fromDate.toISOString().split('T')[0]} 00:00:00`;
  const toDateStr = `${today.toISOString().split('T')[0]} 23:59:59`;

  const url = `${EVENTOR_API_BASE}/events?fromDate=${encodeURIComponent(
    fromDateStr
  )}&toDate=${encodeURIComponent(toDateStr)}&classificationIds=1,2,3,6&EventStatusId=3`;

  // Startlogg i logdata
  const logId = await logApiStart(url, batchId, {
    source: 'GetEvents',
    organisationid: organisationId,
    comment: 'Hämtar events (30 dagar bakåt)',
  });

  let xml;
  let numberOfErrors = 0;

  try {
    const response = await axios.get(url, { headers: { ApiKey: apiKey } });
    console.log('Eventor response status:', response.status);
    xml = response.data;

    // Avsluta loggning OK
    await logApiEnd(logId, response.status, 'OK');
  } catch (err) {
    numberOfErrors += 1;
    const status = err?.response?.status ?? null;
    await logApiError(logId, status, err?.message || 'Okänt fel', url);
    console.error('[GetEvents] Fel vid hämtning av events:', err?.message || err);
    // Markera batch som partial/fel men fortsätt till update i slutet
    xml = null;
  }

  if (!xml) {
    await supabase
      .from('batchrun')
      .update({
        endtime: new Date().toISOString(),
        status: numberOfErrors === 0 ? 'success' : 'partial',
        numberoferrors: numberOfErrors,
        numberofrowsafter: beforeCount || 0,
      })
      .eq('id', batchId);

    return { insertedCount: 0 };
  }

  // Parsning av XML till JS
  const parsed = await parseStringPromise(xml, { explicitArray: true });

  // Hämta club-map för att kunna skapa organiser-namn
  const { data: clubsData } = await supabase.from('clubs').select('organisationid, clubname');
  const clubMap = {};
  (clubsData || []).forEach((c) => (clubMap[String(c.organisationid)] = c.clubname));

  const events = Array.isArray(parsed?.EventList?.Event) ? parsed.EventList.Event : [];
  const rows = events.flatMap((event) => {
    const eventid = parseInt(event.EventId?.[0]);
    const eventnameBase = event.Name?.[0] || '';
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

    const races = Array.isArray(event.EventRace) ? event.EventRace : [event.EventRace];
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
        eventclassificationid: Number.isFinite(eventclassificationid) ? eventclassificationid : null,
        eventdistance,
        eventform,
        batchid: batchId,
      };
    });
  });

  // Upsert events
  const { data: inserted, error: insertError } = await supabase
    .from('events')
    .upsert(rows, { onConflict: 'eventraceid' })
    .select();

  if (insertError) {
    numberOfErrors += 1;
    console.error('[GetEvents] Fel vid upsert till events:', insertError.message);
  }

  // Räkna efter
  const { count: afterCount } = await supabase
    .from('events')
    .select('*', { count: 'exact', head: true });

  // Uppdatera batchrun
  await supabase
    .from('batchrun')
    .update({
      endtime: new Date().toISOString(),
      status: numberOfErrors === 0 ? 'success' : 'partial',
      numberoferrors: numberOfErrors,
      numberofrowsafter: afterCount || 0,
    })
    .eq('id', batchId);

  console.log(`[GetEvents] Inserted ${inserted?.length || 0} events to Supabase`);
  return { insertedCount: inserted?.length || 0 };
}

module.exports = { fetchAndStoreEvents };
