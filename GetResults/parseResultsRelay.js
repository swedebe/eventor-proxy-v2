const { XMLParser } = require('fast-xml-parser');

/**
 * Convert a time string or number into seconds.  Accepts values such as
 * "MM:SS", "HH:MM:SS", numeric seconds (as a number or numeric string)
 * and returns a number representing the total seconds.  Returns null
 * if the value cannot be interpreted.  Relay results sometimes
 * represent time differences as plain numbers (e.g. "8").
 *
 * @param {string|number|undefined|null} value
 * @returns {number|null}
 */
function toSecondsRelay(value) {
  if (value == null) return null;
  // If it's already a number, return as is
  if (typeof value === 'number') {
    return value;
  }
  // Trim and handle numeric strings without colon
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // If purely digits, treat as seconds
    if (/^\d+$/.test(trimmed)) {
      const secs = parseInt(trimmed, 10);
      return Number.isNaN(secs) ? null : secs;
    }
    // Split by colon for HH:MM:SS or MM:SS
    const parts = trimmed.split(':').map((v) => parseInt(v, 10));
    if (parts.some((v) => Number.isNaN(v))) {
      return null;
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
  }
  return null;
}

/**
 * Robustly convert a value to an integer or return null if parsing fails.
 *
 * @param {any} v
 * @returns {number|null}
 */
function toIntOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Map a class type identifier to the so‑called "klassfaktor".  The
 * mapping follows the rules implemented for multi‑day events:
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
 * Parse a PersonId element which may be represented as a string, number
 * or an object containing the text and/or id attributes.  Returns
 * null if no valid identifier can be extracted.  Matches the logic
 * used in the standard and multi‑day parsers.
 *
 * @param {any} personIdRaw
 * @returns {number|null}
 */
function parsePersonId(personIdRaw) {
  if (personIdRaw == null) return null;
  if (typeof personIdRaw === 'string' || typeof personIdRaw === 'number') {
    const parsed = parseInt(personIdRaw, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof personIdRaw === 'object') {
    if (personIdRaw['#text'] != null) {
      const parsed = parseInt(personIdRaw['#text'], 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
    if (personIdRaw['@_id'] != null) {
      const parsed = parseInt(personIdRaw['@_id'], 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Extract a human readable name for a person from a PersonName object.
 * Used when constructing warnings about missing person identifiers.
 *
 * @param {object} person
 * @returns {string}
 */
function getPersonName(person) {
  const fam = person?.PersonName?.Family ?? '<unknown>';
  let given = '';
  const givenField = person?.PersonName?.Given;
  if (typeof givenField === 'string') {
    given = givenField;
  } else if (Array.isArray(givenField)) {
    given = givenField
      .map((g) => (typeof g === 'string' ? g : g?.['#text'] || ''))
      .join(' ');
  }
  // Use template string to combine family and given names safely
  return `${fam} ${given}`.trim();
}

/**
 * Parse relay results XML.  Produces two arrays: results for rows
 * destined for the results table and warnings for non‑fatal
 * anomalies.  Each team member (leg runner) yields one row in
 * results.  Points and ages are computed similarly to the
 * single‑day parser.  Where information is missing or cannot be
 * parsed, fields are set to null and a warning is recorded.
 *
 * @param {string} xmlString
 * @returns {{ results: Array<Object>, warnings: string[] }}
 */
function parseResultsRelay(xmlString) {
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

  // Determine eventId
  let eventId = null;
  if (resultList.Event?.EventId != null) {
    const eid = parseInt(resultList.Event.EventId, 10);
    if (!Number.isNaN(eid)) eventId = eid;
  }

  // Determine event year for age calculation.  Prefer <Event><StartDate><Date>.
  let eventYear = null;
  const dateStr = resultList.Event?.StartDate?.Date;
  if (typeof dateStr === 'string') {
    const match = /^\s*(\d{4})/.exec(dateStr);
    if (match) {
      const yr = parseInt(match[1], 10);
      if (!Number.isNaN(yr)) eventYear = yr;
    }
  }
  if (eventYear == null) {
    warnings.push('Kunde inte läsa eventår från <Event><StartDate><Date>. personage blir null.');
  }

  // Normalise ClassResult into an array
  let classResults = [];
  if (resultList.ClassResult) {
    classResults = Array.isArray(resultList.ClassResult)
      ? resultList.ClassResult
      : [resultList.ClassResult];
  }
  // Log debug information about number of classes
  console.log(`[parseResultsRelay] Antal klasser: ${classResults.length}`);

  for (const classResult of classResults) {
    // Extract class name and class type id
    const eventClassName = classResult?.EventClass?.Name ?? null;
    let classTypeId = null;
    if (classResult?.EventClass?.ClassTypeId != null) {
      const ct = parseInt(classResult.EventClass.ClassTypeId, 10);
      classTypeId = Number.isNaN(ct) ? null : ct;
    }
    const klassfaktor = klassFaktorFromClassTypeId(classTypeId);

    // Determine number of starts (number of teams) for this class
    let classStarts = null;
    // Attribute may be numberOfStarts on ClassResult or noOfStarts on ClassRaceInfo
    if (classResult['@_numberOfStarts'] != null) {
      const cs = parseInt(classResult['@_numberOfStarts'], 10);
      if (!Number.isNaN(cs)) classStarts = cs;
    }
    if (classStarts == null && classResult.ClassRaceInfo?.['@_noOfStarts'] != null) {
      const cs = parseInt(classResult.ClassRaceInfo['@_noOfStarts'], 10);
      if (!Number.isNaN(cs)) classStarts = cs;
    }

    // Determine eventRaceId for this class.  Use ClassRaceInfo first then Event.EventRace.
    let eventRaceId = null;
    if (classResult.ClassRaceInfo?.EventRaceId != null) {
      const er = parseInt(classResult.ClassRaceInfo.EventRaceId, 10);
      if (!Number.isNaN(er)) eventRaceId = er;
    } else if (resultList.Event?.EventRace?.EventRaceId != null) {
      const er = parseInt(resultList.Event.EventRace.EventRaceId, 10);
      if (!Number.isNaN(er)) eventRaceId = er;
    }

    // Normalise TeamResult into array
    let teamResults = [];
    if (classResult.TeamResult) {
      teamResults = Array.isArray(classResult.TeamResult)
        ? classResult.TeamResult
        : [classResult.TeamResult];
    }

    // Log sample from first team to aid troubleshooting
    if (teamResults.length > 0) {
      const sampleTeam = teamResults[0];
      let sampleMembers = [];
      if (sampleTeam.TeamMemberResult) {
        sampleMembers = Array.isArray(sampleTeam.TeamMemberResult)
          ? sampleTeam.TeamMemberResult
          : [sampleTeam.TeamMemberResult];
      }
      if (sampleMembers.length > 0) {
        const sm = sampleMembers[0];
        const sampleTime = sm?.Time;
        const sampleTimeDiff = sm?.OverallResult?.TimeDiff;
        const samplePos = sm?.OverallResult?.ResultPosition;
        const sampleStatus = sm?.CompetitorStatus?.['@_value'] ?? sm?.CompetitorStatus?.value;
        console.log(
          `[DEBUG Klass=${eventClassName}] Exempel: Time=${sampleTime}, TimeDiff=${sampleTimeDiff}, Pos=${samplePos}, Status=${sampleStatus}`
        );
      }
    }

    for (const team of teamResults) {
      // Team-level result position (final) for points fallback if member-level missing
      let teamResultPosition = null;
      if (team?.ResultPosition != null) {
        const rp = parseInt(team.ResultPosition, 10);
        if (!Number.isNaN(rp)) teamResultPosition = rp;
      }

      // Normalise TeamMemberResult into array
      let memberResults = [];
      if (team.TeamMemberResult) {
        memberResults = Array.isArray(team.TeamMemberResult)
          ? team.TeamMemberResult
          : [team.TeamMemberResult];
      }

      for (const tmr of memberResults) {
        if (!tmr || !tmr.Person) continue;

        // Extract personId robustly
        let personId = parsePersonId(tmr.Person.PersonId);
        if (personId == null) {
          const pname = getPersonName(tmr.Person);
          warnings.push(`PersonId saknas för ${pname} – har satt personid=0`);
          personId = 0;
        }

        // Compute age: birth year from BirthDate
        let personage = null;
        const birthDateStr = tmr.Person?.BirthDate?.Date;
        if (typeof birthDateStr === 'string') {
          const m = /^\s*(\d{4})/.exec(birthDateStr);
          if (m) {
            const by = parseInt(m[1], 10);
            if (!Number.isNaN(by) && eventYear != null) {
              personage = eventYear - by;
            }
          }
        }
        // If birth year not available and Age attribute exists
        if (personage == null) {
          const ageRaw = tmr.Person?.Age;
          if (ageRaw != null) {
            const ap = parseInt(ageRaw, 10);
            if (!Number.isNaN(ap)) personage = ap;
          }
        }

        // Competitor's organisation id
        let competitorOrgId = null;
        if (tmr.Organisation?.OrganisationId != null) {
          const co = parseInt(tmr.Organisation.OrganisationId, 10);
          if (!Number.isNaN(co)) competitorOrgId = co;
        }

        // Leg (runner) time in seconds
        const resulttime = toSecondsRelay(tmr.Time);
        // Time difference: prefer OverallResult.TimeDiff, else TimeBehind
        let resulttimediff = null;
        const ovRes = tmr.OverallResult;
        if (ovRes && ovRes.TimeDiff != null) {
          resulttimediff = toSecondsRelay(ovRes.TimeDiff);
        }
        if (resulttimediff == null && tmr.TimeBehind != null) {
          // TimeBehind may be a number or string representing seconds
          resulttimediff = toSecondsRelay(tmr.TimeBehind);
        }

        // Result position: prefer OverallResult.ResultPosition, else team-level
        let resultposition = null;
        if (ovRes && ovRes.ResultPosition != null) {
          const rp = parseInt(ovRes.ResultPosition, 10);
          if (!Number.isNaN(rp)) resultposition = rp;
        }
        if (resultposition == null && teamResultPosition != null) {
          resultposition = teamResultPosition;
        }

        // Competitor status
        let resultcompetitorstatus = null;
        if (tmr.CompetitorStatus) {
          // Attributes parsed with '@_' prefix
          if (tmr.CompetitorStatus['@_value'] != null) {
            resultcompetitorstatus = tmr.CompetitorStatus['@_value'];
          } else if (tmr.CompetitorStatus.value != null) {
            resultcompetitorstatus = tmr.CompetitorStatus.value;
          }
        }

        // Compute points if possible
        let points = null;
        if (klassfaktor != null && resultposition != null && classStarts != null && classStarts > 0) {
          const raw = klassfaktor * (1 - resultposition / classStarts);
          points = Math.round(raw * 100) / 100;
        }

        results.push({
          personid: personId,
          eventid: eventId,
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
  }

  console.log(`[parseResultsRelay] Totalt antal resultat: ${results.length}`);
  return { results, warnings };
}

module.exports = parseResultsRelay;
