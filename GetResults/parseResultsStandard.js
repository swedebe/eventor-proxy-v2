// parseResultsStandard.js
//
// Parser for standard (single-day) Eventor results. Produces flat rows for the
// `results` table. Strict rule (per user spec): ClassTypeId MUST come from
// <ClassTypeId> in the XML; klassfaktor is derived ONLY from that numeric id:
//   16 → 125, 17 → 100, 19 → 75; otherwise null.
// No heuristics based on class names are used.

const { XMLParser } = require('fast-xml-parser');

function toSeconds(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(':').map((v) => parseInt(v, 10));
  if (parts.some((v) => Number.isNaN(v))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function toIntOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

function arrayify(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function klassFaktorFromClassTypeId(classTypeId) {
  if (classTypeId === 16) return 125;
  if (classTypeId === 17) return 100;
  if (classTypeId === 19) return 75;
  return null;
}

function readEventYear(resultList) {
  const dateStr = resultList?.Event?.StartDate?.Date;
  if (typeof dateStr === 'string') {
    const m = /^\s*(\d{4})/.exec(dateStr);
    if (m) {
      const yr = parseInt(m[1], 10);
      if (!Number.isNaN(yr)) return yr;
    }
  }
  return null;
}

/** Robust extraction of number of starts for a class. */
function readClassStarts(classResult) {
  // Primary: attribute on ClassResult
  if (classResult?.['@_numberOfStarts'] != null) {
    const v = parseInt(classResult['@_numberOfStarts'], 10);
    if (!Number.isNaN(v)) return v;
  }
  // Fallbacks commonly seen in Eventor exports
  if (classResult?.EventClass?.ClassRaceInfo?.['@_noOfStarts'] != null) {
    const v = parseInt(classResult.EventClass.ClassRaceInfo['@_noOfStarts'], 10);
    if (!Number.isNaN(v)) return v;
  }
  if (classResult?.ClassRaceInfo?.['@_noOfStarts'] != null) {
    const v = parseInt(classResult.ClassRaceInfo['@_noOfStarts'], 10);
    if (!Number.isNaN(v)) return v;
  }
  return null;
}

/**
 * Parse standard single-day results.
 * @param {string} xmlString
 * @returns {{results: Array<Object>, warnings: string[]}}
 */
function parseResultsStandard(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: true,
    trimValues: true
  });

  const results = [];
  const warnings = [];
  let parsed;

  try {
    parsed = parser.parse(xmlString);
  } catch (err) {
    warnings.push(`XML parse error: ${err.message}`);
    return { results, warnings };
  }

  const resultList = parsed?.ResultList;
  if (!resultList) {
    warnings.push('ResultList saknas i XML');
    return { results, warnings };
  }

  const eventYear = readEventYear(resultList);
  if (eventYear == null) {
    warnings.push('Kunde inte läsa eventår från <Event><StartDate><Date>. personage blir null.');
  }

  const classResults = arrayify(resultList.ClassResult);
  for (const classResult of classResults) {
    const eventClassName = classResult?.EventClass?.Name ?? null;

    // ClassTypeId must be read from XML numerically
    let classTypeId = null;
    if (classResult?.EventClass?.ClassTypeId != null) {
      const ct = parseInt(classResult.EventClass.ClassTypeId, 10);
      classTypeId = Number.isNaN(ct) ? null : ct;
    }
    const klassfaktor = klassFaktorFromClassTypeId(classTypeId);

    // Starts for the class (for points)
    const classStarts = readClassStarts(classResult);

    // We try to get a race id for the class (typical single-day location)
    let classEventRaceId = null;
    if (classResult?.EventClass?.ClassRaceInfo?.EventRaceId != null &&
        classResult.EventClass.ClassRaceInfo.EventRaceId !== '') {
      const r = parseInt(classResult.EventClass.ClassRaceInfo.EventRaceId, 10);
      classEventRaceId = Number.isNaN(r) ? null : r;
    }

    const personResults = arrayify(classResult.PersonResult);
    for (const pr of personResults) {
      // personid robustly
      let personId = null;
      const personIdRaw = pr?.Person?.PersonId;
      if (typeof personIdRaw === 'string' || typeof personIdRaw === 'number') {
        const p = parseInt(personIdRaw, 10);
        personId = Number.isNaN(p) ? null : p;
      } else if (personIdRaw && typeof personIdRaw === 'object') {
        if (personIdRaw['#text'] != null) {
          const p = parseInt(personIdRaw['#text'], 10);
          if (!Number.isNaN(p)) personId = p;
        } else if (personIdRaw['@_id'] != null) {
          const p = parseInt(personIdRaw['@_id'], 10);
          if (!Number.isNaN(p)) personId = p;
        }
      }
      if (personId == null) {
        const fam = pr?.Person?.PersonName?.Family ?? '<unknown>';
        const given = pr?.Person?.PersonName?.Given ?? '';
        warnings.push(`PersonId saknas för ${fam} ${given} – har satt personid=0`);
        personId = 0;
      }

      // Age
      let personage = null;
      const birthDateStr = pr?.Person?.BirthDate?.Date;
      if (typeof birthDateStr === 'string') {
        const m = /^\s*(\d{4})/.exec(birthDateStr);
        if (m && eventYear != null) {
          const by = parseInt(m[1], 10);
          if (!Number.isNaN(by)) personage = eventYear - by;
        }
      }
      if (personage == null && pr?.Person?.Age != null) {
        const a = parseInt(pr.Person.Age, 10);
        if (!Number.isNaN(a)) personage = a;
      }

      // club (organisation) for the competitor
      const competitorOrgId = pr?.Organisation?.OrganisationId != null
        ? toIntOrNull(pr.Organisation.OrganisationId)
        : null;

      // Results are usually under RaceResult[] → Result[] for single-day
      const raceResults = arrayify(pr.RaceResult);
      // Some feeds may put Result directly under PersonResult (less common)
      const directResults = raceResults.length === 0 ? arrayify(pr.Result) : [];

      const resultBlocksByRace = raceResults.length > 0 ? raceResults : directResults.map(r => ({ Result: r }));

      for (const rr of resultBlocksByRace) {
        // prefer class-level EventRaceId, else use per-race one if present
        let eventRaceId = classEventRaceId;
        if (!eventRaceId && rr?.EventRaceId != null) {
          const er = parseInt(rr.EventRaceId, 10);
          if (!Number.isNaN(er)) eventRaceId = er;
        }

        const resultsArray = arrayify(rr?.Result);
        for (const r of resultsArray) {
          const resulttime = toSeconds(r?.Time);
          const resulttimediff = toSeconds(r?.TimeDiff);
          const resultposition = toIntOrNull(r?.ResultPosition);
          const resultcompetitorstatus = r?.CompetitorStatus?.['@_value'] ?? null;

          // Points: ONLY when status is exactly 'OK'
          let points = null;
          if (
            resultcompetitorstatus === 'OK' &&
            klassfaktor != null &&
            resultposition != null &&
            classStarts != null &&
            classStarts > 0
          ) {
            const raw = klassfaktor * (1 - resultposition / classStarts);
            points = Math.round(raw * 100) / 100;
          }

          results.push({
            personid: personId,
            eventid: null,     // set in GetResultsFetcher
            eventraceid: eventRaceId,
            eventclassname: eventClassName,
            resulttime,
            resulttimediff,
            resultposition,
            resultcompetitorstatus,
            classresultnumberofstarts: classStarts,
            classtypeid: classTypeId,
            klassfaktor,
            points,
            personage,
            clubparticipation: competitorOrgId,
            batchid: null      // set in GetResultsFetcher
          });
        }
      }
    }
  }

  return { results, warnings };
}

module.exports = parseResultsStandard;
