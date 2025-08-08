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
 * Map a class type identifier onto the so–called "klassfaktor".  The
 * underlying rules are derived from the historic implementation:
 *   - typeId 16 => 125
 *   - typeId 17 => 100
 *   - typeId 19 => 75
 *   - other/unknown => null
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
 * Parse a multi–day result XML document.  The returned object contains
 * two properties: `results` – an array of row objects – and `warnings`
 * – an array of strings with non–fatal parsing issues.  This parser
 * never throws; if the XML cannot be understood it returns an empty
 * results array alongside a warning.
 *
 * @param {string} xmlString – raw XML string returned from Eventor
 * @param {number|string} eventId – numerical identifier for the event
 * @param {number|string} clubId – organisationId of the club performing the fetch
 * @param {number|string|null} batchId – identifier for the batch run
 * @param {string|null} eventDate – optional event date (YYYY‑MM‑DD) to
 *   calculate competitor ages if the XML lacks a start date
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

  // Attempt to parse the XML.  Any exception is caught and converted
  // into a warning rather than allowing the caller to crash.
  try {
    parsed = parser.parse(xmlString);
  } catch (err) {
    console.warn(`[parseResultsMultiDay] XML parse error: ${err.message}`);
    warnings.push(`XML parse error: ${err.message}`);
    return { results, warnings };
  }

  // Locate the ResultList.  A UTF–8 BOM, namespace prefixes or
  // unusual casing can change the exact key name of the root
  // element.  First try the simple property access.  If it fails,
  // fall back to searching all keys for one that ends with or
  // contains "resultlist" (case insensitive).  If still not
  // found, emit a warning and log the available keys.
  let resultList = parsed?.ResultList;
  if (!resultList) {
    const keys = Object.keys(parsed || {});
    // Search for keys that include "resultlist" regardless of case
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

  // Determine the event year.  Prefer the provided eventDate, then
  // fall back to the StartDate in the XML.  If neither is available
  // the personage field will be null and a warning will be emitted.
  let eventYear = null;
  if (eventDate) {
    const match = /^\d{4}/.exec(eventDate);
    if (match) {
      eventYear = parseInt(match[0], 10);
    }
  }
  if (!eventYear) {
    const dateStr = resultList?.Event?.StartDate?.Date;
    if (typeof dateStr === 'string') {
      const match = /^\d{4}/.exec(dateStr);
      if (match) {
        eventYear = parseInt(match[0], 10);
      }
    }
  }
  if (!eventYear) {
    warnings.push('Kunde inte läsa eventår från <Event><StartDate><Date>. personage blir null.');
  }

  // Normalise ClassResult into an array.  If no ClassResult exists
  // nothing more can be done – simply return the empty results array.
  let classResults = [];
  if (resultList.ClassResult) {
    classResults = Array.isArray(resultList.ClassResult)
      ? resultList.ClassResult
      : [resultList.ClassResult];
  }

  console.log(`[parseResultsMultiDay] Antal klasser: ${classResults.length}`);

  // Iterate over each class
  for (const classResult of classResults) {
    // Extract class name and type
    const eventClassName = classResult?.EventClass?.Name ?? null;
    let classTypeId = null;
    if (classResult?.EventClass?.ClassTypeId != null) {
      const parsedCt = parseInt(classResult.EventClass.ClassTypeId, 10);
      classTypeId = Number.isNaN(parsedCt) ? null : parsedCt;
    }
    const klassfaktor = klassFaktorFromClassTypeId(classTypeId);

    // Normalise PersonResult into an array
    let personResults = [];
    if (classResult.PersonResult) {
      personResults = Array.isArray(classResult.PersonResult)
        ? classResult.PersonResult
        : [classResult.PersonResult];
    }

    // Log a debug sample to aid troubleshooting.  This sample logs
    // the first competitor’s first race result for the current class.
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

    // Iterate over each competitor
    for (const pr of personResults) {
      // Extract person identifier
      const personId = pr?.Person?.PersonId ? parseInt(pr.Person.PersonId, 10) : null;
      // Extract birth year
      let birthYear = null;
      const birthDateStr = pr?.Person?.BirthDate?.Date;
      if (typeof birthDateStr === 'string') {
        const match = /^\d{4}/.exec(birthDateStr);
        if (match) {
          birthYear = parseInt(match[0], 10);
        }
      }
      const personage = birthYear != null && eventYear != null ? eventYear - birthYear : null;
      // The competitor's organisation (club) identifier.  This is
      // distinct from the `clubId` parameter which represents the
      // organisation requesting the import.
      const competitorOrgId = pr?.Organisation?.OrganisationId
        ? parseInt(pr.Organisation.OrganisationId, 10)
        : null;

      // Normalise RaceResult into an array.  Each RaceResult corresponds
      // to a single stage of the multi–day event.
      let raceResults = [];
      if (pr.RaceResult) {
        raceResults = Array.isArray(pr.RaceResult) ? pr.RaceResult : [pr.RaceResult];
      }

      for (const rr of raceResults) {
        // The EventRaceId tells us which stage this result belongs to.
        const eventRaceId = rr?.EventRaceId ? parseInt(rr.EventRaceId, 10) : null;
        if (!eventRaceId) continue;

        // A RaceResult may contain multiple Result blocks.  Typically
        // this would be a single Result per stage, but we normalise
        // regardless.
        let resultBlocks = [];
        if (rr.Result) {
          resultBlocks = Array.isArray(rr.Result) ? rr.Result : [rr.Result];
        }
        for (const r of resultBlocks) {
          const resulttime = toSeconds(r?.Time);
          const resulttimediff = toSeconds(r?.TimeDiff);
          const resultposition = r?.ResultPosition != null ? parseInt(r.ResultPosition, 10) : null;
          const resultcompetitorstatus = r?.CompetitorStatus?.['@_value'] ?? null;

          results.push({
            personid: personId,
            eventid: eventId != null ? parseInt(eventId, 10) : null,
            eventraceid: eventRaceId,
            eventclassname: eventClassName,
            resulttime,
            resulttimediff,
            resultposition,
            resultcompetitorstatus,
            classresultnumberofstarts: null, // multi–day XML contains an incorrect value – explicitly null
            classtypeid: classTypeId,
            klassfaktor,
            points: null,
            personage,
            clubparticipation: competitorOrgId,
            batchid: batchId
          });
        }
      }
    }
  }

  console.log(`[parseResultsMultiDay] Totalt antal resultat: ${results.length}`);
  return { results, warnings };
}

module.exports = parseResultsMultiDay;
