// GetEvents/GetEventsFetcher.js
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

  // Räkna rader innan
  const { count: beforeCount } = await supabase
    .from('events')
    .select('*', { count: 'exact', head: true });

  // Skapa batchrun
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

  // Hämta organiser-namn från eventorclubs (viktigt!)
  const { data: organiserClubs, error: organiserClubsErr } = await supabase
    .from('eventorclubs')
    .select('organisationid, clubname');

  if (organiserClubsErr) {
    console.warn('[GetEvents] Kunde inte läsa eventorclubs:', organiserClubsErr.message);
  }

  const clubMap = {};
  (organiserClubs || []).forEach((c) => (clubMap[String(c.organisationid)] = c.clubname));

  const events = Array.isArray(parsed?.EventList?.Event) ? parsed.EventList.Event : [];

  // Hjälpfunktion: extrahera Organiser-organisationId som strängar
  const getOrganiserIds = (event) => {
    // Vanlig struktur: Event.Organiser[0].OrganisationId: [ "611", "xxx" ]
    let ids =
      (event?.Organiser?.[0]?.OrganisationId || [])
        .map((orgId) => (typeof orgId === 'object' && orgId !== null ? orgId._ ?? orgId : orgId))
        .filter(Boolean) || [];

    // Alternativ struktur: Event.Organiser[].Organisation[].OrganisationId
    if (ids.length === 0 && Array.isArray(event?.Organiser)) {
      ids = event.Organiser.flatMap((o) =>
        (o?.Organisation || [])
          .map((org) => org?.OrganisationId?.[0])
          .filter(Boolean)
      );
    }

    // Som sista fallback: Event.Organisers?.OrganisationId
    if (ids.length === 0) {
      const fallback = event?.Organisers?.[0]?.OrganisationId || [];
      ids = fallback.map((orgId) =>
        typeof orgId === 'object' && orgId !== null ? orgId._ ?? orgId : orgId
      ).filter(Boolean);
    }

    return ids.map(String);
  };

  const rows = events.flatMap((event) => {
    const eventid = parseInt(event.EventId?.[0]);
    const eventnameBase = event.Name?.[0] || '';

    const organiserIds = getOrganiserIds(event);
    const organiserNames = organiserIds
      .map((id) => clubMap[String(id)] || `Organisation ${id}`)
      .join(', ');

    // Spara alltid id:n (viktigt krav)
    const eventorganiser_ids = organiserIds.join(',');

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

      // Extra debug i produktion för att verifiera fixen
      console.log(
        `[GetEvents] Organisers för eventraceid=${eventraceid}: ids=[${eventorganiser_ids}] names="${organiserNames}"`
      );

      return {
        eventid,
        eventraceid,
        eventdate,
        eventname: fullEventName,
        eventorganiser: organiserNames,     // byggt från eventorclubs
        eventorganiser_ids,                 // sparar id-listan oförändrad
        eventclassificationid: Number.isFinite(eventclassificationid) ? eventclassificationid : null,
        eventdistance,
        eventform,
        batchid: batchId,
      };
    });
  });

  /*
   * Before performing the upsert we need to respect the `readonly` flag on
   * existing event rows. If an event has `readonly` = 1 in the `events`
   * table it means the row contains manually curated data and must not be
   * overwritten by automatic imports. To honour this, fetch a list of all
   * eventids marked as readonly and filter out any new rows belonging to
   * those events. The existing rows will remain untouched.
   */
  let upsertRows = rows;
  try {
    const { data: readonlyEvents, error: readonlyErr } = await supabase
      .from('events')
      .select('eventid')
      .eq('readonly', 1);
    if (readonlyErr) {
      console.warn('[GetEvents] Kunde inte läsa readonly-events:', readonlyErr.message);
    } else if (Array.isArray(readonlyEvents) && readonlyEvents.length > 0) {
      const skipEventIds = new Set(readonlyEvents.map((e) => e.eventid));
      upsertRows = rows.filter((row) => !skipEventIds.has(row.eventid));
      const skipped = rows.length - upsertRows.length;
      if (skipped > 0) {
        console.log(`[GetEvents] Skippar ${skipped} rader då deras eventid är readonly`);
      }
    }
  } catch (e) {
    console.warn('[GetEvents] Ovänterat fel vid läsning av readonly-events:', e.message);
  }

  // Upsert events – only rows not marked as readonly will be inserted/updated
  const { data: inserted, error: insertError } = await supabase
    .from('events')
    .upsert(upsertRows, { onConflict: 'eventraceid' })
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
