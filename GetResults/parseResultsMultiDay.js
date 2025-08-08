// parseResultsMultiDay.js
const { XMLParser } = require('fast-xml-parser');

/**
 * Konvertera "MM:SS" eller "H:MM:SS" till sekunder (int).
 * Exempel: "1:02:46" -> 3766, "58:51" -> 3531
 */
function toSeconds(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split(':').map(v => parseInt(v, 10));
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 2) {
    const [m, s] = parts;
    return m * 60 + s;
  }
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return h * 3600 + m * 60 + s;
  }
  return null;
}

/**
 * Klassfaktor baserat på classtypeid.
 * 16 -> 125, 17 -> 100, 19 -> 75, annars null
 */
function klassFaktorFromClassTypeId(classTypeId) {
  if (classTypeId === 16) return 125;
  if (classTypeId === 17) return 100;
  if (classTypeId === 19) return 75;
  return null;
}

/**
 * Huvudparser för IndMultiDay resultat enligt 44022.xml.
 * Observera att vi INTE litar på numberOfEntries/numberOfStarts i XML.
 *
 * @param {string} xmlString Rå XML från Eventor
 * @param {number} eventId   EventId (ex. 44022) – skickas vidare till varje rad
 * @param {number} clubId    OrganisationId för clubparticipation (sätts i Fetcher)
 * @param {string} batchId   Batch-id (sätts i Fetcher)
 * @param {string|null} eventdate Ej använd här; vi tar årtal från XML: <Event><StartDate><Date>
 * @returns {{results: Array<object>, warnings: string[]}}
 */
function parseResultsMultiDay(xmlString, eventId, clubId, batchId, eventdate) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: true,
    trimValues: true
  });

  const parsed = parser.parse(xmlString);
  const warnings = [];
  const results = [];

  if (!parsed?.ResultList) {
    console.warn('[parseResultsMultiDay] ResultList saknas i XML');
    return { results, warnings };
  }

  // Årtal för tävlingen tas från <Event><StartDate><Date> (t.ex. "2025-07-21")
  const eventStartDateStr = parsed.ResultList?.Event?.StartDate?.Date || null;
  const eventYear = eventStartDateStr && /^\d{4}/.test(eventStartDateStr)
    ? parseInt(eventStartDateStr.slice(0, 4), 10)
    : null;

  if (!eventYear) {
    warnings.push('Kunde inte läsa eventår från <Event><StartDate><Date>. personage blir null.');
  }

  // ClassResult kan vara array eller objekt
  const classResults = Array.isArray(parsed.ResultList.ClassResult)
    ? parsed.ResultList.ClassResult
    : parsed.ResultList.ClassResult
    ? [parsed.ResultList.ClassResult]
    : [];

  for (const classResult of classResults) {
    const eventClass = classResult?.EventClass || {};
    const eventClassName = eventClass?.Name ?? null;
    const classTypeId = eventClass?.ClassTypeId != null ? parseInt(eventClass.ClassTypeId, 10) : null;
    const klassfaktor = klassFaktorFromClassTypeId(classTypeId ?? 0);

    // Vi använder inte ClassRaceInfo.noOfStarts från XML eftersom det är felaktigt enligt anvisningarna.
    const classresultnumberofstarts = null;

    // PersonResult kan vara array eller objekt
    const personResults = Array.isArray(classResult.PersonResult)
      ? classResult.PersonResult
      : classResult.PersonResult
      ? [classResult.PersonResult]
      : [];

    for (const pr of personResults) {
      const personId = pr?.Person?.PersonId != null ? parseInt(pr.Person.PersonId, 10) : null;

      // Födelseår
      const birthDateStr = pr?.Person?.BirthDate?.Date || null;
      const birthYear = birthDateStr && /^\d{4}/.test(birthDateStr) ? parseInt(birthDateStr.slice(0, 4), 10) : null;
      const personage = birthYear != null && eventYear != null ? eventYear - birthYear : null;

      // Organisation (klubb) från resultatposten
      const organisationId = pr?.Organisation?.OrganisationId != null
        ? parseInt(pr.Organisation.OrganisationId, 10)
        : null;

      // RaceResult kan vara array eller objekt
      const raceResults = Array.isArray(pr.RaceResult)
        ? pr.RaceResult
        : pr.RaceResult
        ? [pr.RaceResult]
        : [];

      for (const rr of raceResults) {
        const eventRaceId = rr?.EventRaceId != null ? parseInt(rr.EventRaceId, 10) : null;
        const r = rr?.Result;

        // Det ska finnas ett <Result>-block; om saknas hoppar vi över.
        if (!r) continue;

        // Plocka ut de fält du bad om
        const timeStr = r?.Time ?? null;
        const timeDiffStr = r?.TimeDiff ?? null;
        const resultPosition = r?.ResultPosition != null ? parseInt(r.ResultPosition, 10) : null;
        const competitorStatus = r?.CompetitorStatus?.['@_value'] ?? null;

        // Konverteringar
        const resulttime = toSeconds(timeStr);
        const resulttimediff = toSeconds(timeDiffStr);

        // Poäng ska bara beräknas om vi har klassfaktor, position och antal startande.
        // Eftersom antal startande i XML är opålitligt sätter vi null.
        const points = null;

        // Bygg resultatraden
        results.push({
          personid: personId,
          eventid: eventId != null ? parseInt(eventId, 10) : null,
          eventraceid: eventRaceId,
          eventclassname: eventClassName ?? null,
          resulttime,                 // sekunder
          resulttimediff,             // sekunder
          resultposition: resultPosition,
          resultcompetitorstatus: competitorStatus, // ex. "OK", "MisPunch", "DidNotStart"
          classresultnumberofstarts,  // null enligt instruktion
          classtypeid: classTypeId,
          klassfaktor,                // 125/100/75 eller null
          points,                     // null (se kommentar)
          personage,                  // helår: eventYear - birthYear
          organisationid: organisationId // nyttigt för felsökning; kolumn finns i schema
          // batchid och clubparticipation sätts i GetResultsFetcher innan insert
        });
      }
    }
  }

  // Logg: total och per person
  console.log(`[parseResultsMultiDay] Antal resultatrader som tolkats: ${results.length}`);

  const perPerson = new Map();
  for (const row of results) {
    if (!row.personid) continue;
    perPerson.set(row.personid, (perPerson.get(row.personid) || 0) + 1);
  }
  for (const [pid, cnt] of perPerson.entries()) {
    console.log(`[parseResultsMultiDay] personid ${pid}: ${cnt} resultat`);
  }

  return { results, warnings };
}

module.exports = parseResultsMultiDay;
