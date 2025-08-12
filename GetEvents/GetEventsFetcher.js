// GetEventsFetcher.js
// Hämtar tävlingar från Eventor API för ett givet datumintervall och skriver/uppdaterar dem i tabellen `events`.
// Stödjer att intervallet delas upp i flera mindre segment om tidsperioden är lång. Respekterar readonly-rader i tabellen.

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { insertLogData } = require('./logHelpersGetResults.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// För eventimport använder vi en separat supabase-klient. Service-nyckeln ger skrivbehörighet.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Standardklassificeringar att inkludera när inga specificeras
const DEFAULT_CLASSIFICATION_IDS = [1, 2, 3, 6];

/**
 * Hjälpfunktion: formaterar ett Date-objekt till yyyy-mm-dd.
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Beräknar antal dagar mellan två datum.
 * @param {Date} a
 * @param {Date} b
 * @returns {number}
 */
function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Delar upp ett datumintervall i mindre intervall med en maximal längd (antal dagar).
 * @param {Date} start
 * @param {Date} end
 * @param {number} maxDays
 * @returns {Array<{ fromDate: Date, toDate: Date }>}
 */
function chunkDateRange(start, end, maxDays = 90) {
  const ranges = [];
  let chunkStart = new Date(start);
  while (chunkStart <= end) {
    const chunkEnd = new Date(chunkStart.getTime());
    chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    ranges.push({ fromDate: new Date(chunkStart.getTime()), toDate: new Date(chunkEnd.getTime()) });
    // nästa chunk börjar dagen efter nuvarande chunkEnd
    chunkStart = new Date(chunkEnd.getTime());
    chunkStart.setDate(chunkStart.getDate() + 1);
  }
  return ranges;
}

/**
 * Parsar XML-strängen från Eventor till en lista av event-objekt. Varje objekt
 * innehåller åtminstone eventid, name, startdate och enddate om de finns i XML:en.
 * Övriga fält sätts till null om de saknas. Funktionen använder enkla
 * regular expressions snarare än ett komplett XML-bibliotek för att undvika
 * externa beroenden. Om strukturen skulle ändras i framtiden kan denna
 * funktion behöva justeras.
 * @param {string} xml
 * @returns {Array<Object>}
 */
function parseEventListXml(xml) {
  const events = [];
  if (!xml) return events;
  // Hitta alla <Event>...</Event> block
  const eventRegex = /<Event\b[\s\S]*?<\/Event>/gi;
  let match;
  while ((match = eventRegex.exec(xml)) !== null) {
    const eventXml = match[0];
    const idMatch = eventXml.match(/<Id>(\d+)<\/Id>/i);
    const nameMatch = eventXml.match(/<Name>([^<]+)<\/Name>/i);
    // startdate kan ligga i StartDate eller i StartTime/Date beroende på schema
    let startDate = null;
    const startTimeDateMatch = eventXml.match(/<StartTime>\s*<Date>([^<]+)<\/Date>/i);
    const startDateMatch = eventXml.match(/<StartDate>([^<]+)<\/StartDate>/i);
    if (startTimeDateMatch) startDate = startTimeDateMatch[1];
    else if (startDateMatch) startDate = startDateMatch[1];
    let endDate = null;
    const endTimeDateMatch = eventXml.match(/<EndTime>\s*<Date>([^<]+)<\/Date>/i);
    const endDateMatch = eventXml.match(/<EndDate>([^<]+)<\/EndDate>/i);
    if (endTimeDateMatch) endDate = endTimeDateMatch[1];
    else if (endDateMatch) endDate = endDateMatch[1];
    const classificationMatch = eventXml.match(/<ClassificationId>(\d+)<\/ClassificationId>/i);
    const modifyDateMatch = eventXml.match(/<ModifyDate>([^<]+)<\/ModifyDate>/i);
    events.push({
      eventid: idMatch ? Number(idMatch[1]) : null,
      name: nameMatch ? nameMatch[1] : null,
      startdate: startDate || null,
      enddate: endDate || null,
      classificationid: classificationMatch ? Number(classificationMatch[1]) : null,
      modifydate: modifyDateMatch ? modifyDateMatch[1] : null
    });
  }
  return events;
}

/**
 * Hämtar event-data för en enskild tidsperiod från Eventor och upserter dem i
 * tabellen `events`. Respekterar readonly-rader genom att filtrera bort eventid
 * som redan finns med readonly=1. Loggar API-anrop och fel via logHelpers.
 * @param {Object} params
 * @param {string} params.fromDate ISO 8601 datum (YYYY-MM-DD)
 * @param {string} params.toDate ISO 8601 datum (YYYY-MM-DD)
 * @param {Array<number>} params.classificationIds
 * @param {number} params.batchid
 * @returns {Promise<{ inserted: number }>} antal upserterade rader
 */
async function fetchEventsInterval({ fromDate, toDate, classificationIds, batchid }) {
  // Bygg URL för Eventor API. Använd svenska basen.
  const queryParams = [];
  if (fromDate) queryParams.push(`fromDate=${encodeURIComponent(fromDate)}`);
  if (toDate) queryParams.push(`toDate=${encodeURIComponent(toDate)}`);
  if (classificationIds && classificationIds.length > 0) {
    queryParams.push(`classificationIds=${classificationIds.join(',')}`);
  }
  const url = `https://eventor.orientering.se/api/events?${queryParams.join('&')}`;
  const logContext = `[GetEvents] ${fromDate}→${toDate}`;
  const started = new Date();
  let response;
  let xml;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/xml',
        // Sätt API-nyckel om den finns definierad i miljön
        ...(process.env.EVENTOR_API_KEY ? { ApiKey: process.env.EVENTOR_API_KEY } : {})
      },
      timeout: 60000
    });
    xml = await response.text();
  } catch (netErr) {
    console.error(`${logContext} Nätverksfel mot Eventor:`, netErr);
    await insertLogData(supabase, {
      source: 'GetEventsFetcher',
      level: 'error',
      errormessage: `Nätverksfel: ${netErr.message}`,
      batchid,
      request: url,
      started: started.toISOString(),
      completed: new Date().toISOString(),
      responsecode: -1
    });
    return { inserted: 0 };
  }
  const completed = new Date();
  // Logga API-anropet till logdata
  await insertLogData(supabase, {
    source: 'Eventor',
    level: response?.ok ? 'info' : 'error',
    request: url,
    started: started.toISOString(),
    completed: completed.toISOString(),
    responsecode: response?.status ?? -1,
    batchid
  });
  if (!response?.ok) {
    console.warn(`${logContext} Eventor-svar ej OK (${response?.status})`);
    return { inserted: 0 };
  }
  // Parsning av XML till eventlist
  let events;
  try {
    events = parseEventListXml(xml);
  } catch (e) {
    console.error(`${logContext} Fel vid parsning av XML:`, e);
    await insertLogData(supabase, {
      source: 'GetEventsFetcher',
      level: 'error',
      errormessage: `Fel vid parsning: ${e.message}`,
      batchid
    });
    return { inserted: 0 };
  }
  if (!events || events.length === 0) {
    console.log(`${logContext} 0 tävlingar hittades`);
    return { inserted: 0 };
  }
  // Läs vilka eventid som är readonly i databasen
  let readonlyEventIds = [];
  try {
    const ids = events.map(ev => ev.eventid).filter(id => id != null);
    if (ids.length > 0) {
      const { data: rows, error: readErr } = await supabase
        .from('events')
        .select('eventid')
        .in('eventid', ids)
        .eq('readonly', 1);
      if (readErr) {
        console.warn(`${logContext} Kunde inte läsa readonly events:`, readErr.message);
      } else {
        readonlyEventIds = rows.map(r => r.eventid);
      }
    }
  } catch (e) {
    console.warn(`${logContext} Ovänterat fel vid läsning av readonly events:`, e.message);
  }
  // Filtrera bort events vars eventid finns bland readonly
  const filteredEvents = events.filter(ev => !readonlyEventIds.includes(ev.eventid));
  if (filteredEvents.length === 0) {
    console.log(`${logContext} Alla hittade event är readonly – inga uppdateringar`);
    return { inserted: 0 };
  }
  // Upserta eventen i databasen (update or insert). Vi förlitar oss på att det finns en unik constraint på eventid.
  let insertedCount = 0;
  try {
    // Vi använder upsert så att befintliga rader uppdateras (om de inte är readonly, eftersom vi filtrerat bort dem)
    const { data, error } = await supabase
      .from('events')
      .upsert(filteredEvents, { onConflict: 'eventid' })
      .select();
    if (error) {
      console.error(`${logContext} Fel vid upsert av events:`, error.message);
      await insertLogData(supabase, {
        source: 'GetEventsFetcher',
        level: 'error',
        errormessage: `Fel vid upsert: ${error.message}`,
        batchid
      });
    } else {
      // Supabase returnerar de uppdaterade raderna om select() används
      insertedCount = data?.length ?? filteredEvents.length;
    }
  } catch (e) {
    console.error(`${logContext} Ovänterat fel vid upsert:`, e);
    await insertLogData(supabase, {
      source: 'GetEventsFetcher',
      level: 'error',
      errormessage: `Ovänterat fel vid upsert: ${e.message}`,
      batchid
    });
  }
  return { inserted: insertedCount };
}

/**
 * Huvudfunktion för att hämta tävlingar för ett större intervall. Hanterar
 * validering av inparametrar, chunkning och summering av upserterade rader.
 * Parametrar kan vara null/undefined för att använda standardvärden.
 * @param {Object} params
 * @param {string|undefined|null} params.fromDate
 * @param {string|undefined|null} params.toDate
 * @param {Array<number>|undefined|null} params.classificationIds
 * @param {number} params.batchid
 * @returns {Promise<{ success: boolean, insertedRows: number }>}
 */
async function fetchEvents({ fromDate, toDate, classificationIds, batchid }) {
  try {
    // Normalisera datum: default från 30 dagar bakåt till dagens datum
    const now = new Date();
    let startDate = fromDate ? new Date(fromDate) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    let endDate = toDate ? new Date(toDate) : now;
    // Säkerställ att datumen är giltiga
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new Error('Ogiltigt datumformat');
    }
    // Omvänd ordning? byt plats
    if (startDate > endDate) {
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }
    // Standardklassificeringar om inga anges
    const classes = Array.isArray(classificationIds) && classificationIds.length > 0 ? classificationIds : DEFAULT_CLASSIFICATION_IDS;
    // Om tidsintervallet är längre än ett år, dela upp i max 90-dagarsbitar
    const totalDays = daysBetween(startDate, endDate);
    const chunks = totalDays > 365 ? chunkDateRange(startDate, endDate, 90) : [{ fromDate: startDate, toDate: endDate }];
    let totalInserted = 0;
    for (const chunk of chunks) {
      const fromStr = formatDate(chunk.fromDate);
      const toStr = formatDate(chunk.toDate);
      const { inserted } = await fetchEventsInterval({ fromDate: fromStr, toDate: toStr, classificationIds: classes, batchid });
      totalInserted += inserted;
    }
    return { success: true, insertedRows: totalInserted };
  } catch (e) {
    console.error('[GetEventsFetcher] Ovänterat fel:', e);
    await insertLogData(supabase, {
      source: 'GetEventsFetcher',
      level: 'error',
      errormessage: `Ovänterat fel: ${e.message}`,
      batchid
    });
    return { success: false, insertedRows: 0 };
  }
}

module.exports = { fetchEvents };