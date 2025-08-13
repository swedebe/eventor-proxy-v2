// GetEvents/GetEventsFetcher.js
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { logApiStart, logApiEnd, logApiError } = require('./GetEventsLogger');
const { parseStringPromise } = require('xml2js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const EVENTOR_API_BASE = 'https://eventor.orientering.se/api';

/**
 * Hämtar och lagrar events för en viss organisation inom ett givet datumintervall.
 * Om ingen tidsperiod anges hämtas som standard de senaste 30 dagarna. En lista
 * med klassificerings-id:n kan skickas in, annars används standardvärdena
 * [1,2,3,6]. Vid längre intervall (över ca 90 dagar) delas anropet upp i
 * mindre segment för att undvika tidsgränser hos Eventor. Alla segment
 * används i samma batchrun så att resultat och fel summeras.
 *
 * @param {string|number} organisationId Organisationens Eventor ID
 * @param {object} [options] Valfria parametrar
 * @param {string|Date} [options.fromDate] Startdatum (YYYY-MM-DD) eller Date
 * @param {string|Date} [options.toDate] Slutdatum (YYYY-MM-DD) eller Date
 * @param {Array<number>} [options.classificationIds] Lista med klassificerings-id:n
 * @returns {Promise<{ insertedCount: number }>} Antal upsertade rader
 */
async function fetchAndStoreEvents(organisationId, options = {}) {
  const initiatedBy = 'manual';
  const appVersion = null;
  const renderJobId = process.env.RENDER_INSTANCE_ID || null;
  const comment = 'Hämtning av events';

  // Räkna rader innan import för att logga batchrun
  const { count: beforeCount } = await supabase
    .from('events')
    .select('*', { count: 'exact', head: true });

  // Skapa batchrun. numberofrequests justeras senare om segmentering används.
  const { data: batchData, error: batchError } = await supabase
    .from('batchrun')
    .insert([
      {
        clubparticipation: organisationId,
        starttime: new Date().toISOString(),
        status: 'running',
        comment,
        numberofrequests: 0, // uppdateras efter segmentering
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

  // Hämta API‑nyckel för klubben (per organisation)
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

  // Beräkna datumintervall och segmentering
  const msPerDay = 24 * 60 * 60 * 1000;
  let startDate;
  let endDate;
  try {
    // Normalisera inparametrar. Om ej angivet används standard 30 dagar bakåt.
    if (options.fromDate) {
      startDate = options.fromDate instanceof Date ? options.fromDate : new Date(options.fromDate);
    }
    if (options.toDate) {
      endDate = options.toDate instanceof Date ? options.toDate : new Date(options.toDate);
    }
    const now = new Date();
    if (!endDate) endDate = now;
    if (!startDate) startDate = new Date(endDate.getTime() - 30 * msPerDay);
    // Om start efter slut – byt plats
    if (startDate > endDate) {
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }
  } catch (e) {
    console.error('[GetEvents] Ogiltigt datumformat:', e.message);
    throw new Error('Ogiltigt datumformat');
  }

  // Klassificerings-ID:n
  const classIds = Array.isArray(options.classificationIds) && options.classificationIds.length > 0
    ? options.classificationIds
    : [1, 2, 3, 6];

  // Dela upp i segment om intervallet är långt (>90 dagar)
  const totalDays = Math.floor((endDate.getTime() - startDate.getTime()) / msPerDay);
  const segments = [];
  if (totalDays > 90) {
    let segStart = new Date(startDate.getTime());
    while (segStart <= endDate) {
      const segEnd = new Date(segStart.getTime());
      segEnd.setDate(segEnd.getDate() + 89);
      if (segEnd > endDate) segEnd.setTime(endDate.getTime());
      segments.push({ from: new Date(segStart.getTime()), to: new Date(segEnd.getTime()) });
      segStart = new Date(segEnd.getTime() + msPerDay);
    }
  } else {
    segments.push({ from: startDate, to: endDate });
  }

  // Uppdatera batchrun med antal segment som numberofrequests
  try {
    await supabase
      .from('batchrun')
      .update({ numberofrequests: segments.length })
      .eq('id', batchId);
  } catch (e) {
    console.warn('[GetEvents] Kunde inte uppdatera numberofrequests i batchrun:', e.message);
  }

  // Hämta organiser-namn från eventorclubs en gång för alla segment
  const { data: organiserClubs, error: organiserClubsErr } = await supabase
    .from('eventorclubs')
    .select('organisationid, clubname');
  const clubMap = {};
  (organiserClubs || []).forEach((c) => (clubMap[String(c.organisationid)] = c.clubname));
  if (organiserClubsErr) {
    console.warn('[GetEvents] Kunde inte läsa eventorclubs:', organiserClubsErr.message);
  }

  let totalInserted = 0;
  let totalErrors = 0;

  // Funktion för att extrahera organisatörs-ID:n
  const getOrganiserIds = (event) => {
    let ids =
      (event?.Organiser?.[0]?.OrganisationId || [])
        .map((orgId) =>
          typeof orgId === 'object' && orgId !== null ? orgId._ ?? orgId : orgId
        )
        .filter(Boolean) || [];
    if (ids.length === 0 && Array.isArray(event?.Organiser)) {
      ids = event.Organiser.flatMap((o) =>
        (o?.Organisation || [])
          .map((org) => org?.OrganisationId?.[0])
          .filter(Boolean)
      );
    }
    if (ids.length === 0) {
      const fallback = event?.Organisers?.[0]?.OrganisationId || [];
      ids = fallback
        .map((orgId) =>
          typeof orgId === 'object' && orgId !== null ? orgId._ ?? orgId : orgId
        )
        .filter(Boolean);
    }
    return ids.map(String);
  };

  // Loop över alla segment
  for (const segment of segments) {
    const fromStr = `${segment.from.toISOString().split('T')[0]} 00:00:00`;
    const toStr = `${segment.to.toISOString().split('T')[0]} 23:59:59`;
    const url = `${EVENTOR_API_BASE}/events?fromDate=${encodeURIComponent(
      fromStr
    )}&toDate=${encodeURIComponent(toStr)}&classificationIds=${classIds.join(',')}&EventStatusId=3`;

    // Logga API-anropet
    const logId = await logApiStart(url, batchId, {
      source: 'GetEvents',
      organisationid: organisationId,
      comment: `Hämtar events (${fromStr} – ${toStr})`
    });

    let xml;
    try {
      const response = await axios.get(url, { headers: { ApiKey: apiKey } });
      console.log(`[GetEvents] Eventor response status: ${response.status}`);
      xml = response.data;
      await logApiEnd(logId, response.status, 'OK');
    } catch (err) {
      totalErrors += 1;
      const status = err?.response?.status ?? null;
      await logApiError(logId, status, err?.message || 'Okänt fel', url);
      console.error('[GetEvents] Fel vid hämtning av events:', err?.message || err);
      xml = null;
    }

    if (!xml) {
      continue; // hoppa över till nästa segment
    }

    // Parsning av XML till JS
    let parsed;
    try {
      parsed = await parseStringPromise(xml, { explicitArray: true });
    } catch (e) {
      totalErrors += 1;
      console.error('[GetEvents] Fel vid XML-parsning:', e.message);
      await logApiError(logId, null, `XML-parsning: ${e.message}`, url);
      continue;
    }

    const events = Array.isArray(parsed?.EventList?.Event) ? parsed.EventList.Event : [];

    // Bygg rader för upsert per segment
    const segmentRows = events.flatMap((event) => {
      const eventid = parseInt(event.EventId?.[0]);
      const eventnameBase = event.Name?.[0] || '';
      const organiserIds = getOrganiserIds(event);
      const organiserNames = organiserIds
        .map((id) => clubMap[String(id)] || `Organisation ${id}`)
        .join(', ');
      const eventorganiser_ids = organiserIds.join(',');
      const eventclassificationid = parseInt(event.EventClassificationId?.[0]);
      const eventform = event.$?.eventForm || null;

      // NYTT: DisciplineId
      const disciplineid = event?.DisciplineId ? parseInt(event.DisciplineId[0]) : null;

      const races = Array.isArray(event.EventRace) ? event.EventRace : [event.EventRace];
      if (!races || !races[0]) return [];
      return races.map((race) => {
        const eventraceid = parseInt(race.EventRaceId?.[0]);
        const racename = race.Name?.[0] || '';
        const eventdate = race.RaceDate?.[0]?.Date?.[0] || race.EventDate?.[0];
        const eventdistance = race.WRSInfo?.[0]?.Distance?.[0] || null;
        const fullEventName = eventform === 'IndMultiDay' ? `${eventnameBase} – ${racename}` : eventnameBase;
        // Extraloggar för felsökning
        console.log(
          `[GetEvents] Organisers för eventraceid=${eventraceid}: ids=[${eventorganiser_ids}] names="${organiserNames}"`
        );
        return {
          eventid,
          eventraceid,
          eventdate,
          eventname: fullEventName,
          eventorganiser: organiserNames,
          eventorganiser_ids,
          eventclassificationid: Number.isFinite(eventclassificationid) ? eventclassificationid : null,
          eventdistance,
          eventform,
          disciplineid: Number.isFinite(disciplineid) ? disciplineid : null, // <-- NY KOLUMN
          batchid: batchId,
        };
      });
    });

    // Filtrera bort eventid som är readonly
    let upsertRows = segmentRows;
    try {
      const ids = segmentRows.map((r) => r.eventid).filter((id) => id != null);
      if (ids.length > 0) {
        const { data: readonlyEvents, error: readonlyErr } = await supabase
          .from('events')
          .select('eventid')
          .in('eventid', ids)
          .eq('readonly', 1);
        if (readonlyErr) {
          console.warn('[GetEvents] Kunde inte läsa readonly-events:', readonlyErr.message);
        } else if (Array.isArray(readonlyEvents) && readonlyEvents.length > 0) {
          const skipEventIds = new Set(readonlyEvents.map((e) => e.eventid));
          upsertRows = segmentRows.filter((row) => !skipEventIds.has(row.eventid));
          const skipped = segmentRows.length - upsertRows.length;
          if (skipped > 0) {
            console.log(`[GetEvents] Skippar ${skipped} rader då deras eventid är readonly`);
          }
        }
      }
    } catch (e) {
      console.warn('[GetEvents] Ovänterat fel vid läsning av readonly-events:', e.message);
    }

    // Upsert raderna för detta segment
    try {
      const { data: inserted, error: insertError } = await supabase
        .from('events')
        .upsert(upsertRows, { onConflict: 'eventraceid' })
        .select();
      if (insertError) {
        totalErrors += 1;
        console.error('[GetEvents] Fel vid upsert till events:', insertError.message);
      } else {
        totalInserted += inserted?.length || upsertRows.length;
      }
    } catch (e) {
      totalErrors += 1;
      console.error('[GetEvents] Ovänterat fel vid upsert:', e.message);
    }
  }

  // Räkna efter
  let afterCount = beforeCount || 0;
  try {
    const { count: c, error: countErr } = await supabase
      .from('events')
      .select('*', { count: 'exact', head: true });
    if (countErr) {
      console.error('[GetEvents] Fel vid count (efter):', countErr.message);
    } else {
      afterCount = c || 0;
    }
  } catch (e) {
    console.error('[GetEvents] Ovänterat fel vid count (efter):', e.message);
  }

  // Uppdatera batchrun med slutstatus
  try {
    await supabase
      .from('batchrun')
      .update({
        endtime: new Date().toISOString(),
        status: totalErrors === 0 ? 'success' : 'partial',
        numberoferrors: totalErrors,
        numberofrowsafter: afterCount,
      })
      .eq('id', batchId);
  } catch (e) {
    console.error('[GetEvents] Fel vid uppdatering av batchrun:', e.message);
  }

  console.log(`[GetEvents] Inserted ${totalInserted} events to Supabase`);
  return { insertedCount: totalInserted };
}

module.exports = { fetchAndStoreEvents };
