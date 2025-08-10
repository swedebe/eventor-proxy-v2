// GetResults/parseResultsRelay.js
const { XMLParser } = require('fast-xml-parser');

/**
 * Convert a time string or number into seconds.
 * Accepts "MM:SS", "HH:MM:SS" or a numeric string (already seconds).
 * Returns null if the value cannot be interpreted.
 */
function toSecondsRelay(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const secs = parseInt(trimmed, 10);
      return Number.isNaN(secs) ? null : secs;
    }
    const parts = trimmed.split(':').map((v) => parseInt(v, 10));
    if (parts.some((v) => Number.isNaN(v))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

function toIntOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

function klassFaktorFromClassTypeId(classTypeId) {
  if (classTypeId === 16) return 125;
  if (classTypeId === 17) return 100;
  if (classTypeId === 19) return 75;
  return null;
}

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
  } else if (typeof givenField === 'object' && givenField !== null) {
    given = givenField['#text'] ?? '';
  }
  return `${fam} ${given}`.trim();
}

/** Hämta Given med sequence="1" (case-insensitivt), robust för sträng/objekt/array. */
function getGivenSeq1(person) {
  const given = person?.PersonName?.Given;
  if (!given) return null;
  if (typeof given === 'string') return given;
  if (Array.isArray(given)) {
    const g1 = given.find(
      (g) => (typeof g === 'object' && g?.['@_sequence'] === '1') || typeof g === 'string'
    );
    if (g1 == null) return null;
    if (typeof g1 === 'string') return g1;
    return g1['#text'] ?? null;
  }
  if (typeof given === 'object') {
    if (!given['@_sequence'] || given['@_sequence'] === '1') {
      return given['#text'] ?? null;
    }
  }
  return null;
}

/** Primär klubb på Team-nivå: första <Organisation><OrganisationId> om flera finns. */
function getTeamPrimaryOrgId(teamResult) {
  const org = teamResult?.Organisation;
  if (!org) return null;
  const list = Array.isArray(org) ? org : [org];
  for (const o of list) {
    const id = toIntOrNull(o?.OrganisationId);
    if (id != null) return id;
  }
  return null;
}

/**
 * Parse relay results XML into flat rows for `results` and collect warnings.
 * IMPORTANT:
 * - importingOrganisationId: den klubb som anropet gjordes för (t.ex. 114).
 *   Vi behåller ENDAST TeamMemberResult där
 *     a) Given sequence="1" != "vacant", och
 *     b) TeamMemberResult.Organisation.OrganisationId === importingOrganisationId
 * - clubparticipation sätts till löparens klubb (OrganisationId på member-nivå).
 * - Om Event.eventForm === "RelaySingleDay" sätts classresultnumberofstarts till null (ignoreras).
 */
function parseResultsRelay(xmlString, importingOrganisationId) {
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

  // Event metadata
  const eventFormRaw = resultList?.Event?.['@_eventForm'] || null;
  const eventForm = typeof eventFormRaw === 'string' ? eventFormRaw.trim() : null;
  const isRelaySingleDay = (eventForm || '').toLowerCase() === 'relaysingleday';

  let eventId = null;
  if (resultList.Event?.EventId != null) {
    const eid = parseInt(resultList.Event.EventId, 10);
    if (!Number.isNaN(eid)) eventId = eid;
  }

  // Event year for age calculation
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

  // Normalise ClassResult
  const classResults = resultList.ClassResult
    ? Array.isArray(resultList.ClassResult)
      ? resultList.ClassResult
      : [resultList.ClassResult]
    : [];

  console.log(`[parseResultsRelay] Antal klasser: ${classResults.length}`);

  for (const classResult of classResults) {
    const eventClassName = classResult?.EventClass?.Name ?? null;

    // classtypeid / klassfaktor
    let classTypeId = null;
    if (classResult?.EventClass?.ClassTypeId != null) {
      const ct = parseInt(classResult.EventClass.ClassTypeId, 10);
      classTypeId = Number.isNaN(ct) ? null : ct;
    }
    const klassfaktor = klassFaktorFromClassTypeId(classTypeId);

    // classresultnumberofstarts (antal lag i klassen)
    // VIKTIGT: På stafetter (RelaySingleDay) ska vi inte hämta/visa antal lag → alltid null.
    let classStarts = null;
    if (!isRelaySingleDay) {
      if (classResult['@_numberOfStarts'] != null) {
        const cs = parseInt(classResult['@_numberOfStarts'], 10);
        if (!Number.isNaN(cs)) classStarts = cs;
      }
      if (classStarts == null && classResult?.ClassRaceInfo?.['@_noOfStarts'] != null) {
        const cs = parseInt(classResult.ClassRaceInfo['@_noOfStarts'], 10);
        if (!Number.isNaN(cs)) classStarts = cs;
      }
    } else {
      // För diagnos: hjälp oss se om XML faktiskt innehöll siffror som vi ignorerar.
      const xmlStartsAttr = classResult['@_numberOfStarts'] ?? classResult?.ClassRaceInfo?.['@_noOfStarts'] ?? null;
      if (xmlStartsAttr != null) {
        warnings.push(
          `Event ${eventId}: Ignorerar antal lag (numberOfStarts=${xmlStartsAttr}) eftersom eventForm=RelaySingleDay.`
        );
      }
    }

    // eventraceid
    let eventRaceId = null;
    if (classResult?.ClassRaceInfo?.EventRaceId != null) {
      const er = parseInt(classResult.ClassRaceInfo.EventRaceId, 10);
      if (!Number.isNaN(er)) eventRaceId = er;
    } else if (resultList?.Event?.EventRace?.EventRaceId != null) {
      const er = parseInt(resultList.Event.EventRace.EventRaceId, 10);
      if (!Number.isNaN(er)) eventRaceId = er;
    }

    // TeamResult array
    const teamResults = classResult?.TeamResult
      ? Array.isArray(classResult.TeamResult)
        ? classResult.TeamResult
        : [classResult.TeamResult]
      : [];

    for (const tr of teamResults) {
      // Team-level fields (apply per leg row)
      const relayteamname = tr?.TeamName ?? null;

      let relayteamendposition = null;
      if (tr?.ResultPosition != null) {
        const rp = parseInt(tr.ResultPosition, 10);
        if (!Number.isNaN(rp)) relayteamendposition = rp;
      }

      let relayteamenddiff = null; // to seconds
      if (tr?.TimeDiff != null) {
        relayteamenddiff = toSecondsRelay(tr.TimeDiff);
      }

      let relayteamendstatus = null;
      if (tr?.TeamStatus) {
        relayteamendstatus =
          tr.TeamStatus['@_value'] ?? tr.TeamStatus.value ?? null;
      }

      // Primär lagklubb (för varningar) – men filtret sker mot importingOrganisationId
      const teamPrimaryOrgId = getTeamPrimaryOrgId(tr);

      // Members per team → one DB row per member
      const memberResults = tr?.TeamMemberResult
        ? Array.isArray(tr.TeamMemberResult)
          ? tr.TeamMemberResult
          : [tr.TeamMemberResult]
        : [];

      for (const tmr of memberResults) {
        // Skip 1: vacant?
        const given1 = (getGivenSeq1(tmr?.Person) || '').trim().toLowerCase();
        if (given1 === 'vacant') {
          const name = getPersonName(tmr?.Person || {});
          warnings.push(
            `Ignorerar 'vacant' löpare (Given seq=1=vacant) i team "${relayteamname ?? '(okänt)'}". Namn: ${name || '<tomt>'}`
          );
          continue;
        }

        // Löparens klubb (OrganisationId)
        let competitorOrgId = null;
        if (tmr?.Organisation?.OrganisationId != null) {
          const oid = parseInt(tmr.Organisation.OrganisationId, 10);
          if (!Number.isNaN(oid)) competitorOrgId = oid;
        }

        // Skip 2: fel klubb jämfört med importerande klubb
        if (
          importingOrganisationId != null &&
          competitorOrgId != null &&
          competitorOrgId !== importingOrganisationId
        ) {
          const name = getPersonName(tmr?.Person || {});
          warnings.push(
            `Ignorerar ${name} (personid=${parsePersonId(tmr?.Person?.PersonId) ?? 'okänd'}) – löparens klubb (${competitorOrgId}) matchar ej importerande klubb (${importingOrganisationId}).`
          );
          continue;
        }

        // personid (0 + warning om saknas)
        let personId = parsePersonId(tmr?.Person?.PersonId);
        if (personId == null) {
          personId = 0;
          const name = getPersonName(tmr?.Person || {});
          warnings.push(`PersonId saknas för ${name} – har satt personid=0`);
        }

        // competitor age
        let personage = null;
        const birthDateStr = tmr?.Person?.BirthDate?.Date;
        if (typeof birthDateStr === 'string') {
          const m = /^\s*(\d{4})/.exec(birthDateStr);
          if (m && eventYear != null) {
            const by = parseInt(m[1], 10);
            if (!Number.isNaN(by)) personage = eventYear - by;
          }
        }
        if (personage == null && tmr?.Person?.Age != null) {
          const a = parseInt(tmr.Person.Age, 10);
          if (!Number.isNaN(a)) personage = a;
        }

        // leg-specific values
        const relayleg = toIntOrNull(tmr?.Leg);

        // resulttime = tmr.Time (leg time) → seconds
        const resulttime = toSecondsRelay(tmr?.Time);

        // resulttimediff = TimeBehind type="Leg"
        const timeBehindLegRaw = readTypedValue(tmr?.TimeBehind, 'Leg');
        const resulttimediff = toSecondsRelay(timeBehindLegRaw);

        // resultposition = Position type="Leg"
        const positionLegRaw = readTypedValue(tmr?.Position, 'Leg');
        const resultposition = toIntOrNull(positionLegRaw);

        // relaylegoverallposition = OverallResult/ResultPosition (team rank after this leg)
        let relaylegoverallposition = null;
        const ovRes = tmr?.OverallResult;
        if (ovRes?.ResultPosition != null) {
          const rp = parseInt(ovRes.ResultPosition, 10);
          if (!Number.isNaN(rp)) relaylegoverallposition = rp;
        }

        // resultcompetitorstatus from <CompetitorStatus>
        let resultcompetitorstatus = null;
        if (tmr?.CompetitorStatus) {
          resultcompetitorstatus =
            tmr.CompetitorStatus['@_value'] ?? tmr.CompetitorStatus.value ?? null;
        }

        // points only when all needed values exist – men classStarts är null på RelaySingleDay → points blir null
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
          // core identity
          personid: personId,
          eventid: eventId,
          eventraceid: eventRaceId,
          eventclassname: eventClassName,

          // team-level final outcome
          relayteamname,
          relayteamendposition,
          relayteamenddiff,
          relayteamendstatus,

          // leg-level specifics
          relayleg,
          relaylegoverallposition,
          resultposition,
          resulttime,
          resulttimediff,
          resultcompetitorstatus,

          // class/meta
          classresultnumberofstarts: classStarts, // null för RelaySingleDay
          classtypeid: classTypeId,
          klassfaktor,
          points,

          // person
          personage,

          // behåll löparens klubb (ska inte skrivas över i fetchern)
          clubparticipation: competitorOrgId ?? null
        });

        // Info-varning om teamets primära klubb skiljer sig från importerande klubb (diagnostik)
        if (teamPrimaryOrgId != null && importingOrganisationId != null && teamPrimaryOrgId !== importingOrganisationId) {
          warnings.push(
            `Team "${relayteamname ?? '(okänt)'}": primär teamklubb (${teamPrimaryOrgId}) ≠ importerande klubb (${importingOrganisationId}).`
          );
        }
      }
    }
  }

  console.log(`[parseResultsRelay] Totalt antal resultat: ${results.length}`);
  return { results, warnings };
}

function readTypedValue(node, wantedType = 'Leg') {
  if (node == null) return null;

  if (typeof node === 'string' || typeof node === 'number') return node;

  if (!Array.isArray(node)) {
    if (node['@_type'] && node['@_type'] !== wantedType) return null;
    return node['#text'] ?? node.value ?? null;
  }

  const typed = node.find((n) => n && n['@_type'] === wantedType);
  const pick = typed ?? node[0];
  if (pick == null) return null;
  if (typeof pick === 'string' || typeof pick === 'number') return pick;
  return pick['#text'] ?? pick.value ?? null;
}

module.exports = parseResultsRelay;
