// parseResultsMultiDay.js
//
// Parser for multi–day (IndMultiDay) events returned from Eventor. A multi–day
// event contains one or more stages (EventRace) and produces a separate
// PersonResult entry for each stage.  The goal of this parser is to
// normalise the XML structure into a flat list of result rows suitable
// for insertion into the `results` table.  Each row represents a single
// competitor on a single stage.  Fields are mapped according to the
// specification provided in the project description.  Where data is
// missing or cannot be calculated, the parser fills values with `null`.

const { XMLParser } = require('fast-xml-parser');

/**
 * Robustly extract the given (first) name from a Person record.  This
 * replicates the logic used in parseResultsStandard to handle
 * variations in the XML structure where Given may be a string,
 * array, or object with sequence attributes.
 *
 * @param {Object|null|undefined} person
 * @returns {string|null}
 */
function getGiven(person) {
  const given = person?.PersonName?.Given;
  if (!given) return null;
  if (typeof given === 'string') return given?.trim() || null;
  if (Array.isArray(given)) {
    // Prefer sequence="1" or missing sequence on objects
    const seq1 = given.find(
      (g) => typeof g === 'object' && (g['@_sequence'] === '1' || g['@_sequence'] == null)
    );
    if (seq1) return (seq1['#text'] || '').trim() || null;
    // Otherwise join string-like parts
    const joined = given
      .map((g) => (typeof g === 'string' ? g : (g?.['#text'] || '')))
      .filter(Boolean)
      .join(' ')
      .trim();
    return joined || null;
  }
  if (typeof given === 'object') {
    if (!given['@_sequence'] || given['@_sequence'] === '1') {
      return (given['#text'] || '').trim() || null;
    }
    return (given['#text'] || '').trim() || null;
  }
  return null;
}

/**
 * Convert a time string in the format HH:MM:SS or MM:SS into seconds.  If
 * the input is not recognised the function returns `null`.
 *
 * @param {string|number|undefined|null} value
 * @returns {number|null}
 */
function toSeconds(value) {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const parts = value.trim().split(':').map((v) => parseInt(v, 10));
  if (parts.some((v) => Number.isNaN(v))) {
    return null;
  }
  // Two parts means MM:SS, three parts means HH:MM:SS
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

/**
 * Map a class type identifier onto the so–called "klassfaktor".
 *   16 => 125, 17 => 100, 19 => 75; other => null
 *
 * @param {number|null} classTypeId
 * @returns {number|null}
 */
function klassFaktorFromClassTypeId(classTypeId) {
  if (classTypeId === 16) return 125;
  if (classTypeId === 17) return 100;
  if (classTypeId === 19) return 75;
  return null;
}

/**
 * Parse a multi–day result XML document.
 *
 * @param {string} xmlString – raw XML string returned from Eventor
 * @param {number|string} eventId
 * @param {number|string} clubId
 * @param {number|string|null} batchId
 * @param {string|null} eventDate
 * @returns {{ results: Array<Object>, warnings: string[] }}
 */
function parseResultsMultiDay(xmlString, eventId, clubId, batchId, eventDate = null) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: true,
    trimValues: true
  });

  let parsed;
  const results = [];
  const warnings = [];

  try {
    parsed = parser.parse(xmlString);
  } catch (err) {
    console.warn(`[parseResultsMultiDay] XML parse error: ${err.message}`);
    warnings.push(`XML parse error: ${err.message}`);
    return { results, warnings };
  }

  // Locate ResultList robustly
  let resultList = parsed?.ResultList;
  if (!resultList) {
    const keys = Object.keys(parsed || {});
    for (const key of keys) {
      if (/resultlist$/i.test(key) || /resultlist/i.test(key)) {
        resultList = parsed[key];
        break;
      }
    }
    if (!resultList) {
      console.warn(
        `[parseResultsMultiDay] Kunde inte hitta ResultList. Tillgängliga root-nycklar: ${keys.join(', ')}`
      );
      warnings.push('ResultList saknas i XML');
      return { results, warnings };
    }
  }

  // Event year
  let eventYear = null;
  if (eventDate) {
    const match = /^\d{4}/.exec(eventDate);
    if (match) eventYear = parseInt(match[0], 10);
  }
  if (!eventYear) {
    const dateStr = resultList?.Event?.StartDate?.Date;
    if (typeof dateStr === 'string') {
      const match = /^\d{4}/.exec(dateStr);
      if (match) eventYear = parseInt(match[0], 10);
    }
  }
  if (!eventYear) {
    warnings.push('Kunde inte läsa eventår från <Event><StartDate><Date>. personage blir null.');
  }

  // ClassResult array
  let classResults = [];
  if (resultList.ClassResult) {
    classResults = Array.isArray(resultList.ClassResult)
      ? resultList.ClassResult
      : [resultList.ClassResult];
  }

  console.log(`[parseResultsMultiDay] Antal klasser: ${classResults.length}`);

  for (const classResult of classResults) {
    const eventClassName = classResult?.EventClass?.Name ?? null;

    // ClassTypeId / klassfaktor
    let classTypeId = null;
    if (classResult?.EventClass?.ClassTypeId != null) {
      const parsedCt = parseInt(classResult.EventClass.ClassTypeId, 10);
      classTypeId = Number.isNaN(parsedCt) ? null : parsedCt;
    }
    const klassfaktor = klassFaktorFromClassTypeId(classTypeId);

    // PersonResult[]
    let personResults = [];
    if (classResult.PersonResult) {
      personResults = Array.isArray(classResult.PersonResult)
        ? classResult.PersonResult
        : [classResult.PersonResult];
    }

    // Optional debug: sample values
    if (personResults.length > 0) {
      const samplePr = personResults[0];
      let sampleRaceArray = [];
      if (samplePr.RaceResult) {
        sampleRaceArray = Array.isArray(samplePr.RaceResult)
          ? samplePr.RaceResult
          : [samplePr.RaceResult];
      }
      if (sampleRaceArray.length > 0) {
        const sampleRr = sampleRaceArray[0];
        let sampleResultArray = [];
        if (sampleRr?.Result) {
          sampleResultArray = Array.isArray(sampleRr.Result)
            ? sampleRr.Result
            : [sampleRr.Result];
        }
        const s = sampleResultArray[0] || {};
        console.log(
          `[DEBUG Klass=${eventClassName}] Exempel: Time=${s?.Time}, TimeDiff=${s?.TimeDiff}, Pos=${s?.ResultPosition}, Status=${s?.CompetitorStatus?.['@_value']}`
        );
      }
    }

    for (const pr of personResults) {
      // personid robust
      let personId = null;
      const personIdRaw = pr?.Person?.PersonId;
      if (typeof personIdRaw === 'string' || typeof personIdRaw === 'number') {
        const parsed = parseInt(personIdRaw, 10);
        personId = Number.isNaN(parsed) ? null : parsed;
      } else if (personIdRaw && typeof personIdRaw === 'object') {
        if (personIdRaw['#text'] != null) {
          const parsed = parseInt(personIdRaw['#text'], 10);
          if (!Number.isNaN(parsed)) personId = parsed;
        } else if (personIdRaw['@_id'] != null) {
          const parsed = parseInt(personIdRaw['@_id'], 10);
          if (!Number.isNaN(parsed)) personId = parsed;
        }
      }
      if (personId == null) {
        const fam = pr?.Person?.PersonName?.Family ?? '<unknown>';
        const givenField = pr?.Person?.PersonName?.Given;
        let given;
        if (typeof givenField === 'string') {
          given = givenField;
        } else if (Array.isArray(givenField)) {
          given = givenField
            .map((g) => (typeof g === 'string' ? g : g?.['#text'] || ''))
            .join(' ');
        } else {
          given = '';
        }
        warnings.push(`PersonId saknas för ${fam} ${given} – har satt personid=0`);
        personId = 0;
      }

      // age
      let birthYear = null;
      const birthDateStr = pr?.Person?.BirthDate?.Date;
      if (typeof birthDateStr === 'string') {
        const match = /^\d{4}/.exec(birthDateStr);
        if (match) {
          birthYear = parseInt(match[0], 10);
        }
      }
      const personage = birthYear != null && eventYear != null ? eventYear - birthYear : null;

      // competitor org id
      const competitorOrgId = pr?.Organisation?.OrganisationId
        ? parseInt(pr.Organisation.OrganisationId, 10)
        : null;

      // Extract names for diagnostics and xmlpersonname backup
      const personFamilyName = pr?.Person?.PersonName?.Family ?? null;
      const personGivenName = getGiven(pr?.Person) ?? null;
      const nameParts = [];
      if (personGivenName) nameParts.push(personGivenName);
      if (personFamilyName) nameParts.push(personFamilyName);
      const xmlPersonName = nameParts.length > 0 ? nameParts.join(' ') : undefined;

      // RaceResult[]
      let raceResults = [];
      if (pr.RaceResult) {
        raceResults = Array.isArray(pr.RaceResult) ? pr.RaceResult : [pr.RaceResult];
      }

      for (const rr of raceResults) {
        const eventRaceId = rr?.EventRaceId ? parseInt(rr.EventRaceId, 10) : null;
        if (!eventRaceId) continue;

        // Result[]
        let resultBlocks = [];
        if (rr.Result) {
          resultBlocks = Array.isArray(rr.Result) ? rr.Result : [rr.Result];
        }
        for (const r of resultBlocks) {
          const resulttime = toSeconds(r?.Time);
          const resulttimediff = toSeconds(r?.TimeDiff);
          const resultposition = r?.ResultPosition != null ? parseInt(r.ResultPosition, 10) : null;
          const resultcompetitorstatus = r?.CompetitorStatus?.['@_value'] ?? null;

          // Points: ONLY when status is 'OK', and (for multi-day we normally set starts to null)
          // Keep behaviour: classresultnumberofstarts is null for multi–day per spec.
          let points = null;
          const classresultnumberofstarts = null;

          if (
            resultcompetitorstatus === 'OK' &&
            klassfaktor != null &&
            resultposition != null &&
            classresultnumberofstarts != null &&
            classresultnumberofstarts > 0
          ) {
            const raw = klassfaktor * (1 - resultposition / classresultnumberofstarts);
            points = Math.round(raw * 100) / 100;
          }

          // Build result row and include transient names plus backup xmlpersonname if available
          const row = {
            personid: personId,
            eventid: eventId != null ? parseInt(eventId, 10) : null,
            eventraceid: eventRaceId,
            eventclassname: eventClassName,
            resulttime,
            resulttimediff,
            resultposition,
            resultcompetitorstatus,
            classresultnumberofstarts, // explicitly null on multi‑day
            classtypeid: classTypeId,
            klassfaktor,
            points,
            personage,
            clubparticipation: competitorOrgId,
            batchid: batchId,
            // Transient fields for diagnostics; not persisted
            persongiven: personGivenName,
            personfamily: personFamilyName
          };
          if (xmlPersonName) row.xmlpersonname = xmlPersonName;
          results.push(row);
        }
      }
    }
  }

  console.log(`[parseResultsMultiDay] Totalt antal resultat: ${results.length}`);
  return { results, warnings };
}

module.exports = parseResultsMultiDay;
