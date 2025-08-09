const { XMLParser } = require('fast-xml-parser');

/**
 * parseResultsStandard
 *
 * This parser normalises the XML returned by Eventor for a standard
 * single‑day event (eventForm "Individual") into an array of row
 * objects suitable for insertion into the `results` table.  It also
 * collects non‑fatal warnings about missing or malformed fields.  The
 * function never throws; if the XML cannot be understood it returns
 * an empty result array alongside a warning explaining what went
 * wrong.
 *
 * @param {string} xmlString – raw XML string returned from Eventor
 * @returns {{ results: Array<Object>, warnings: string[] }}
 */
function parseResultsStandard(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: true,
    trimValues: true
  });

  let parsed;
  const results = [];
  const warnings = [];

  // Try parsing the XML.  If parsing fails we cannot proceed.
  try {
    parsed = parser.parse(xmlString);
  } catch (err) {
    warnings.push(`XML parse error: ${err.message}`);
    return { results, warnings };
  }

  // Ensure we have a ResultList and at least one ClassResult.  If not
  // there is nothing to parse.
  const resultList = parsed?.ResultList;
  if (!resultList || !resultList.ClassResult) {
    warnings.push('ResultList eller ClassResult saknas i XML');
    return { results, warnings };
  }

  // Determine the event year from the Event StartDate, if present.  This
  // is used to calculate competitor ages when Age is not explicitly
  // provided in the XML.  If the year cannot be determined we leave
  // eventYear as null and personage will be null for those rows.
  let eventYear = null;
  const startDateStr = resultList?.Event?.StartDate?.Date;
  if (typeof startDateStr === 'string') {
    const m = /^\s*(\d{4})/.exec(startDateStr);
    if (m) {
      const yr = parseInt(m[1], 10);
      if (!Number.isNaN(yr)) eventYear = yr;
    }
  }
  if (eventYear == null) {
    warnings.push('Kunde inte läsa eventår från <Event><StartDate><Date>. personage blir null.');
  }

  // Normalise ClassResult into an array.
  const classResults = Array.isArray(resultList.ClassResult)
    ? resultList.ClassResult
    : [resultList.ClassResult];

  for (const classResult of classResults) {
    // Extract the class name and number of starts.  If these are
    // missing they default to null or zero.  Note that the attribute
    // names on ClassRaceInfo vary between Eventor schemas.  We use
    // '@_noOfStarts' when ClassRaceInfo is under EventClass and
    // '@_noOfStarts' directly on ClassResult.ClassRaceInfo for older
    // schemas.
    const eventClassName = classResult?.EventClass?.Name ?? null;
    let classStarts = null;
    if (classResult?.EventClass?.ClassRaceInfo?.['@_noOfStarts'] != null) {
      classStarts = parseInt(
        classResult.EventClass.ClassRaceInfo['@_noOfStarts'],
        10
      );
      if (Number.isNaN(classStarts)) classStarts = null;
    } else if (classResult?.ClassRaceInfo?.['@_noOfStarts'] != null) {
      classStarts = parseInt(classResult.ClassRaceInfo['@_noOfStarts'], 10);
      if (Number.isNaN(classStarts)) classStarts = null;
    }

    // Determine class type and klassfaktor via naming heuristics.  This
    // mirrors the behaviour of the legacy implementation: all D/H/Open
    // classes return typeId 17 and factor 100; Blå/Orange/Grön/Gul/Svart
    // return typeId 19 and factor 75; all others return null.
    const classTypeId = getClassTypeId(eventClassName);
    const klassfaktor = getKlassFaktor(eventClassName);

    // Ensure PersonResult is always an array for iteration.
    const personResults = Array.isArray(classResult.PersonResult)
      ? classResult.PersonResult
      : classResult.PersonResult
      ? [classResult.PersonResult]
      : [];

    for (const pr of personResults) {
      if (!pr || !pr.Person) continue;

      // Robustly extract the personId.  PersonId may be a string,
      // number, or an object containing '#text' or '@_id'.  If no
      // valid identifier is found we set personId to 0 and record a
      // warning.  Missing PersonId is non‑fatal; we still include
      // the row for completeness.
      let personId = null;
      const personIdRaw = pr.Person.PersonId;
      if (typeof personIdRaw === 'string' || typeof personIdRaw === 'number') {
        const parsedId = parseInt(personIdRaw, 10);
        if (!Number.isNaN(parsedId)) personId = parsedId;
      } else if (personIdRaw && typeof personIdRaw === 'object') {
        if (personIdRaw['#text'] != null) {
          const parsedId = parseInt(personIdRaw['#text'], 10);
          if (!Number.isNaN(parsedId)) personId = parsedId;
        } else if (personIdRaw['@_id'] != null) {
          const parsedId = parseInt(personIdRaw['@_id'], 10);
          if (!Number.isNaN(parsedId)) personId = parsedId;
        }
      }
      if (personId == null) {
        personId = 0;
        // Build a human‑readable name from PersonName to aid
        // troubleshooting.  Both Family and Given can be arrays or
        // single strings depending on language tags in the XML.
        const fam = pr.Person.PersonName?.Family ?? '<unknown>';
        let given = '';
        const givenField = pr.Person.PersonName?.Given;
        if (typeof givenField === 'string') {
          given = givenField;
        } else if (Array.isArray(givenField)) {
          given = givenField
            .map((g) => (typeof g === 'string' ? g : g?.['#text'] || ''))
            .join(' ');
        }
        warnings.push(`PersonId saknas för ${fam} ${given} – har satt personid=0`);
      }

      // Compute competitor age.  Prefer BirthDate if available.  Fall
      // back to Age property.  If neither are present or the
      // computation fails, personage is null.
      let personage = null;
      // Attempt to parse birth year from <Person><BirthDate><Date>
      const birthDateStr = pr.Person?.BirthDate?.Date;
      if (typeof birthDateStr === 'string') {
        const m = /^\s*(\d{4})/.exec(birthDateStr);
        if (m) {
          const by = parseInt(m[1], 10);
          if (!Number.isNaN(by) && eventYear != null) {
            personage = eventYear - by;
          }
        }
      }
      // If birthYear not used and Age attribute exists
      if (personage == null) {
        const ageRaw = pr.Person?.Age;
        if (ageRaw != null) {
          const ageParsed = parseInt(ageRaw, 10);
          if (!Number.isNaN(ageParsed)) {
            personage = ageParsed;
          }
        }
      }

      // Determine competitor's organisation (club) id.  This field is
      // distinct from the organisation performing the import.
      let competitorOrgId = null;
      if (pr.Organisation?.OrganisationId != null) {
        const parsedOrg = parseInt(pr.Organisation.OrganisationId, 10);
        if (!Number.isNaN(parsedOrg)) competitorOrgId = parsedOrg;
      }

      // Each standard event has only one race per class.  The EventRaceId
      // is stored inside ClassRaceInfo.  If not present we set it to
      // null, which is acceptable for single‑day events.
      let eventRaceId = null;
      if (
        classResult?.EventClass?.ClassRaceInfo?.EventRaceId != null &&
        classResult.EventClass.ClassRaceInfo.EventRaceId !== ''
      ) {
        const parsedRace = parseInt(
          classResult.EventClass.ClassRaceInfo.EventRaceId,
          10
        );
        if (!Number.isNaN(parsedRace)) eventRaceId = parsedRace;
      }

      // Extract the single Result block.  In standard events there is
      // exactly one Result per PersonResult.
      const resBlock = pr.Result ?? pr.Result;
      const resulttime = toSeconds(resBlock?.Time);
      const resulttimediff = toSeconds(resBlock?.TimeDiff);
      const resultposition = toIntOrNull(resBlock?.ResultPosition);
      const resultcompetitorstatus = resBlock?.CompetitorStatus?.['@_value'] ?? null;

      // Calculate points using klassfaktor if possible.  Points are
      // calculated as klassfaktor * (1 - (position / starts)) and
      // rounded to two decimals.  If any value is missing the points
      // field is null.
      let points = null;
      if (
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
        eventid: parseInt(resultList.Event.EventId, 10),
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
        clubparticipation: competitorOrgId
      });
    }
  }

  return { results, warnings };
}

// === Hjälpfunktioner ===

/**
 * Convert a time value into seconds.  Accepts values such as
 * "MM:SS", "HH:MM:SS" or numeric seconds.  Returns null if the
 * value cannot be parsed.
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
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

/**
 * Convert a value to an integer or return null if parsing fails.
 *
 * @param {any} v
 * @returns {number|null}
 */
function toIntOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Derive a class type id from the class name.  The rules are:
 *   - classes starting with H, D, Open, Motion, Inskolning, U, Ö, N => 17
 *   - classes starting with Blå, Grön, Gul, Orange, Svart => 19
 *   - otherwise => null
 *
 * @param {string|null} name
 * @returns {number|null}
 */
function getClassTypeId(name) {
  if (!name) return null;
  if (/^(H|D|Open|Motion|Inskolning|U|Ö|N)/i.test(name)) return 17;
  if (/^(Blå|Grön|Gul|Orange|Svart)/i.test(name)) return 19;
  return null;
}

/**
 * Derive a klassfaktor from the class name.  The rules mirror
 * getClassTypeId: "Blå|Orange|Grön|Gul|Svart" => 75; others => 100.
 *
 * @param {string|null} name
 * @returns {number|null}
 */
function getKlassFaktor(name) {
  if (!name) return null;
  if (/^(Blå|Orange|Grön|Gul|Svart)/i.test(name)) return 75;
  return 100;
}

module.exports = parseResultsStandard;
