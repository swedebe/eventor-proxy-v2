// GetPersons/GetPersonsFetcher.js
// Fetches persons via Eventor API and upserts into 'persons' table (no deletes).
// Updates only rows for the same organisationid (onConflict: organisationid,personid).
// Adjusted:
//  - eventormodifydate (ISO) stored instead of modifydate
//  - nationalitycountryid ignored
//  - personnamegiven extracted specifically from <Given sequence="1">...</Given>
// Production debugging: strips unknown columns reported by Supabase and retries.

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { XMLParser } = require('fast-xml-parser');
const { v4: uuidv4 } = require('uuid');
const { logApiStart, logApiEnd, logApiError, insertLogData } = require('./GetPersonsLogger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EVENTOR_API_BASE = 'https://eventor.orientering.se/api';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function asString(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  if (typeof v === 'object') return null;
  return String(v);
}

function combineToIso(dateStr, clockStr) {
  const d = asString(dateStr);
  const t = asString(clockStr);
  if (!d) return null;
  if (t) return `${d}T${t}`;
  return d;
}

// Extracts the Given name, prioritizing <Given sequence="1">...</Given>.
// Handles cases where Given is a single object with attributes or an array of objects/strings.
function extractGiven(rawGiven) {
  if (rawGiven == null) return null;

  // If array: try to find sequence="1" first, else first with text, else first string
  if (Array.isArray(rawGiven)) {
    // Prefer an object with @_sequence === '1'
    const seq1 = rawGiven.find(g => g && typeof g === 'object' && g['@_sequence'] === '1');
    if (seq1) {
      if (typeof seq1['#text'] === 'string') return String(seq1['#text']);
      if (typeof seq1 === 'string') return seq1;
    }
    // Next: any object that has #text
    const anyObjWithText = rawGiven.find(g => g && typeof g === 'object' && typeof g['#text'] === 'string');
    if (anyObjWithText) return String(anyObjWithText['#text']);
    // Finally: any string entry
    const anyStr = rawGiven.find(g => typeof g === 'string');
    if (anyStr) return anyStr;
    return null;
  }

  // If object: fast-xml-parser typically gives { '#text': 'Bengt', '@_sequence': '1' }
  if (typeof rawGiven === 'object') {
    if (typeof rawGiven['#text'] === 'string') return String(rawGiven['#text']);
    // Fallbacks (unlikely)
    const keys = Object.keys(rawGiven);
    for (const k of keys) {
      const val = rawGiven[k];
      if (typeof val === 'string') return val;
    }
    return null;
  }

  // Primitive string/number fallback
  return asString(rawGiven);
}

function parsePersonsXml(xmlString, organisationId) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    trimValues: true,
  });

  const out = [];
  const warnings = [];

  let root;
  try {
    root = parser.parse(xmlString);
  } catch (e) {
    warnings.push(`XML parse error: ${e.message}`);
    return { persons: out, warnings };
  }

  const list = root?.PersonList;
  if (!list) {
    warnings.push('PersonList saknas i XML');
    return { persons: out, warnings };
  }

  const persons = Array.isArray(list.Person) ? list.Person : list.Person ? [list.Person] : [];

  for (const p of persons) {
    const personid = Number(asString(p?.PersonId));
    if (!Number.isFinite(personid)) {
      warnings.push('Hoppar över person utan giltigt PersonId');
      continue;
    }

    const family = asString(p?.PersonName?.Family);
    const given = extractGiven(p?.PersonName?.Given);

    const sex = asString(p?.['@_sex']); // attribute sex="M|F"
    const birthdate = asString(p?.BirthDate?.Date);
    const modifyIso = combineToIso(p?.ModifyDate?.Date, p?.ModifyDate?.Clock);

    const row = {
      organisationid: organisationId, // per requirement
      personid,
      personsex: sex,
      personnamefamily: family,
      personnamegiven: given,
      personbirthdate: birthdate,
      eventormodifydate: modifyIso,
      // batchid is added in fetchAndStorePersons
    };

    out.push(row);
  }

  return { persons: out, warnings };
}

function stripColumn(rows, col) {
  if (!col) return rows;
  return rows.map(r => {
    const copy = { ...r };
    delete copy[col];
    return copy;
  });
}

async function fetchAndStorePersons(organisationId) {
  const initiatedBy = 'auto';
  const appVersion = null;
  const renderJobId = process.env.RENDER_INSTANCE_ID || null;
  const comment = 'Hämtning av persons';

  const { count: beforeCount } = await supabase
    .from('persons')
    .select('*', { count: 'exact', head: true })
    .eq('organisationid', organisationId);

  const batchid = uuidv4();
  const { error: batchErr } = await supabase.from('batchrun').insert([{
    id: batchid,
    clubparticipation: organisationId,
    starttime: new Date().toISOString(),
    status: 'running',
    comment,
    numberofrequests: 1,
    initiatedby: initiatedBy,
    renderjobid: renderJobId,
    appversion: appVersion,
    numberofrowsbefore: beforeCount || 0,
  }]);
  if (batchErr) {
    console.error('[GetPersons] Misslyckades skapa batchrun:', batchErr.message);
  }

  let apiKey = process.env.EVENTOR_API_KEY || process.env.EventorApiKey || null;
  const { data: clubRow, error: clubErr } = await supabase
    .from('clubs')
    .select('apikey')
    .eq('organisationid', organisationId)
    .single();
  if (!clubErr && clubRow?.apikey) {
    apiKey = clubRow.apikey;
  }

  const url = `${EVENTOR_API_BASE}/persons/organisations/${organisationId}`;

  const logStartId = await logApiStart({
    source: 'GetPersonsFetcher',
    organisationid: organisationId,
    request: url,
    comment: 'GET persons/organisations',
  });

  let xml = null;
  let numberOfErrors = 0;

  try {
    const response = await axios.get(url, {
      headers: {
        ApiKey: apiKey,
        Accept: 'application/xml',
      },
    });
    xml = response.data;
    await logApiEnd(logStartId, '200 OK');
  } catch (err) {
    numberOfErrors = 1;
    await logApiError(logStartId, err);
    console.error('[GetPersons] API-fel:', err?.message);
    await supabase.from('batchrun').update({
      endtime: new Date().toISOString(),
      status: 'error',
      numberoferrors: numberOfErrors,
    }).eq('id', batchid);
    return { insertedCount: 0, updatedCount: 0, warnings: [`API error: ${err?.message}`] };
  }

  const { persons, warnings } = parsePersonsXml(xml, organisationId);

  let rows = persons.map(r => ({ ...r, batchid }));
  let insertedCount = 0;
  let updatedCount = 0;
  const triedToRemove = new Set();

  while (true) {
    const { data, error } = await supabase
      .from('persons')
      .upsert(rows, { onConflict: 'organisationid,personid', returning: 'representation' });

    if (!error) {
      const returned = Array.isArray(data) ? data : [];
      insertedCount = returned.length;
      updatedCount = 0;
      break;
    }

    const msg = error?.message || '';
    console.error('[GetPersons] Upsert error:', msg);

    const m1 = msg.match(/column\s+"?([a-zA-Z0-9_]+)"?\s+does not exist/i);
    const m2 = msg.match(/could not find the '([^']+)' column/i);
    const missingCol = (m1 && m1[1]) || (m2 && m2[1]) || null;

    if (missingCol && !triedToRemove.has(missingCol)) {
      console.warn(`[GetPersons] Tar bort okänd kolumn "${missingCol}" och försöker igen`);
      rows = stripColumn(rows, missingCol);
      triedToRemove.add(missingCol);
      continue;
    }

    numberOfErrors = 1;
    break;
  }

  const { count: afterCount } = await supabase
    .from('persons')
    .select('*', { count: 'exact', head: true })
    .eq('organisationid', organisationId);

  await supabase
    .from('batchrun')
    .update({
      endtime: new Date().toISOString(),
      status: numberOfErrors === 0 ? 'success' : (insertedCount > 0 ? 'partial' : 'error'),
      numberoferrors: numberOfErrors,
      numberofrowsafter: afterCount || 0,
    })
    .eq('id', batchid);

  await insertLogData({
    source: 'GetPersonsFetcher',
    level: numberOfErrors === 0 ? 'info' : 'warn',
    organisationid: organisationId,
    comment: `Persons upsert: ${insertedCount} rader (efter=${afterCount ?? 0}). Warnings: ${warnings.length}`,
    batchid,
  });

  return {
    batchid,
    insertedCount,
    updatedCount,
    warnings,
  };
}

module.exports = { fetchAndStorePersons };
