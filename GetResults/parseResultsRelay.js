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
 * Försök hämta EventRace-id från olika kända ställen i Eventors stafett-XML.
 * Prioritet:
 *   1) teamResult.EventRace['@_id']          (det vi explicitly vill säkra)
 *   2) classResult.ClassRaceInfo.EventRace['@_id'] (ibland ligger det på klassnivå)
 *   3) teamResult.EventRaceId                (fallback – äldre/alternativ struktur)
 *   4) teamResult.RaceId                     (sista utväg)
 */
function getEventRaceId(teamResult, classResult) {
  // 1) <EventRace id="...">
  const trEventRace = teamResult?.EventRace;
  if (trEventRace) {
    if (Array.isArray(trEventRace)) {
      for (const er of trEventRace) {
        const id = toIntOrNull(er?.['@_id'] ?? er?.['@_raceId'] ?? er?.['@_Id']);
        if (id != null) return id;
      }
    } else {
      const id = toIntOrNull(
        trEventRace?.['@_id'] ?? trEventRace?.['@_raceId'] ?? trEventRace?.['@_Id']
      );
      if (id != null) return id;
    }
  }

  // 2) På klassnivå
  const crEventRace = classResult?.ClassRaceInfo?.EventRace;
  if (crEventRace) {
    if (Array.isArray(crEventRace)) {
      for (const er of crEventRace) {
        const id = toIntOrNull(er?.['@_id'] ?? er?.['@_raceId'] ?? er?.['@_Id']);
        if (id != null) return id;
      }
    } else {
      const id = toIntOrNull(
        crEventRace?.['@_id'] ?? crEventRace?.['@_raceId'] ?? crEventRace?.['@_Id']
      );
      if (id != null) return id;
    }
  }

  // 3) Fallback: EventRaceId
  const byEventRaceIdTag = toIntOrNull(teamResult?.EventRaceId);
  if (byEventRaceIdTag != null) return byEventRaceIdTag;

  // 4) Fallback: RaceId
  const byRaceIdTag = toIntOrNull(teamResult?.RaceId);
  if (byRaceIdTag != null) return byRaceIdTag;

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
 * - Poäng beräknas ENDAST om resultcompetitorstatus === 'OK'.
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
      classStarts = null;
    }

    // Each TeamResult is a team in the relay
    const teamResults = classResult?.TeamResult
      ? Array.isArray(classResult.TeamResult)
        ? classResult.TeamResult
        : [classResult.TeamResult]
      : [];

    for (const teamResult of teamResults) {
      const relayteamname = teamResult?.TeamName ?? null;
      const relayteamendposition = toIntOrNull(teamResult?.ResultPosition);
      const relayteamenddiff = toSecondsRelay(teamResult?.TimeBehind);
      const relayteamendstatus = teamResult?.TeamStatus?.['@_value'] ?? null;

      // primary organisation for this team (for diagnostics)
      const teamPrimaryOrgId = getTeamPrimaryOrgId(teamResult);

      // NEW: robust hämtning av EventRace-id
      const eventRaceId = getEventRaceId(teamResult, classResult);

      // Each TeamMemberResult is a leg/competitor
      const memberResults = teamResult?.TeamMemberResult
        ? Array.isArray(teamResult.TeamMemberResult)
          ? teamResult.TeamMemberResult
          : [teamResult.TeamMemberResult]
        : [];

      for (const tmr of memberResults) {
        // Skip 1: "vacant" placeholders
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

        // points only when all needed values exist AND status is 'OK'
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

        // Extract person family and given names for downstream diagnostics
        const personFamilyName = tmr?.Person?.PersonName?.Family ?? null;
        const personGivenName = getGivenSeq1(tmr?.Person) ?? null;

        // Construct backup XML person name (given + family) if present
        const nameParts = [];
        if (personGivenName) nameParts.push(personGivenName);
        if (personFamilyName) nameParts.push(personFamilyName);
        const xmlPersonName = nameParts.length > 0 ? nameParts.join(' ') : undefined;

        results.push({
          // core identity
          personid: personId,
          eventid: eventId,
          eventraceid: eventRaceId, // ← SÄKRAD FRÅN <EventRace id="...">
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

          // include names for better warnings in fetcher; these fields are not persisted to DB
          persongiven: personGivenName,
          personfamily: personFamilyName,

          // Persist backup name from XML when available
          ...(xmlPersonName ? { xmlpersonname: xmlPersonName } : {}),

          // behåll löparens klubb (ska inte skrivas över i fetchern)
          clubparticipation: competitorOrgId ?? null
        });

        // Info-varning om teamets primära klubb skiljer sig från importerande klubb (diagnostik)
        if (
          teamPrimaryOrgId != null &&
          importingOrganisationId != null &&
          teamPrimaryOrgId !== importingOrganisationId
        ) {
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
