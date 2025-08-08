// parseResultsMultiDay.js
const { XMLParser } = require('fast-xml-parser');

/**
 * Konverterar strängformat HH:MM[:SS] till sekunder.
 */
function toSeconds(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split(':').map(v => parseInt(v, 10));
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * Klassfaktor från ClassTypeId enligt tidigare logik:
 * 16 = Elit → 125, 17 = Ålders-/öppna → 100, 19 = Färgnivå → 75
 */
function klassFaktorFromClassTypeId(classTypeId) {
  if (classTypeId === 16) return 125;
  if (classTypeId === 17) return 100;
  if (classTypeId === 19) return 75;
  return null;
}

/**
 * parseResultsMultiDay
 * OBS: För flerdagarstävling ska classresultnumberofstarts INTE hämtas eller sparas.
 *
 * @param {string} xmlString - XML från Eventor
 * @param {number|string} eventId - EventId
 * @param {number|string} clubId - organisationId (klubben som importeras)
 * @param {string} batchId - batchrun.id
 * @param {string|null} eventDateOverride - (valfritt) ISO-YYYY-MM-DD från tabellen events; används för åldersberäkning om satt
 * @returns {{results: Array<object>, warnings: Array<string>}}
 */
function parseResultsMultiDay(xmlString, eventId, clubId, batchId, eventDateOverride = null) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: true,
    trimValues: true
  });

  const parsed = parser.parse(xmlString);
  const results = [];
  const warnings = [];

  if (!parsed?.ResultList) {
    console.warn('[parseResultsMultiDay] ResultList saknas i XML');
    return { results, warnings };
  }

  // År för åldersberäkning: prioritera eventDateOverride (från events.eventdate), annars StartDate i XML
  let eventYear = null;
  if (eventDateOverride && typeof eventDateOverride === 'string' && eventDateOverride.length >= 4) {
    const y = parseInt(eventDateOverride.slice(0, 4), 10);
    if (!Number.isNaN(y)) eventYear = y;
  }
  if (!eventYear) {
    const xmlDate = parsed.ResultList?.Event?.StartDate?.Date;
    if (xmlDate && typeof xmlDate === 'string' && xmlDate.length >= 4) {
      const y = parseInt(xmlDate.slice(0, 4), 10);
      if (!Number.isNaN(y)) eventYear = y;
    }
  }
  if (!eventYear) {
    warnings.push('Kunde inte läsa eventår (varken override eller från <Event><StartDate><Date>). personage blir null.');
  }

  const classResults = Array.isArray(parsed.ResultList.ClassResult)
    ? parsed.ResultList.ClassResult
    : parsed.ResultList.ClassResult
    ? [parsed.ResultList.ClassResult]
    : [];

  console.log(`[parseResultsMultiDay] Antal klasser: ${classResults.length}`);

  for (const classResult of classResults) {
    const eventClassName = classResult?.EventClass?.Name ?? null;
    const classTypeId = classResult?.EventClass?.ClassTypeId != null
      ? parseInt(classResult.EventClass.ClassTypeId, 10)
      : null;
    const klassfaktor = klassFaktorFromClassTypeId(classTypeId);

    const personResults = Array.isArray(classResult.PersonResult)
      ? classResult.PersonResult
      : classResult.PersonResult
      ? [classResult.PersonResult]
      : [];

    // Debug: visa första löparen i varje klass
    if (personResults.length > 0) {
      const samplePr = personResults[0];
      const sampleRr = Array.isArray(samplePr.RaceResult) ? samplePr.RaceResult[0] : samplePr.RaceResult;
      const sampleRes = Array.isArray(sampleRr?.Result) ? sampleRr.Result[0] : sampleRr?.Result;
      console.log(
        `[DEBUG Klass=${eventClassName}] Exempel: ` +
        `Time=${sampleRes?.Time}, TimeDiff=${sampleRes?.TimeDiff}, ` +
        `Pos=${sampleRes?.ResultPosition}, Status=${sampleRes?.CompetitorStatus?.['@_value']}`
      );
    }

    for (const pr of personResults) {
      const personId = pr?.Person?.PersonId ? parseInt(pr.Person.PersonId, 10) : null;
      const birthYear = pr?.Person?.BirthDate?.Date?.slice(0, 4)
        ? parseInt(pr.Person.BirthDate.Date.slice(0, 4), 10)
        : null;
      const personage = birthYear && eventYear ? eventYear - birthYear : null;
      const organisationId = pr?.Organisation?.OrganisationId
        ? parseInt(pr.Organisation.OrganisationId, 10)
        : null;

      const raceResults = Array.isArray(pr.RaceResult)
        ? pr.RaceResult
        : pr.RaceResult
        ? [pr.RaceResult]
        : [];

      for (const rr of raceResults) {
        const eventRaceId = rr?.EventRaceId ? parseInt(rr.EventRaceId, 10) : null;
        if (!eventRaceId) continue;

        const resultBlocks = Array.isArray(rr.Result) ? rr.Result : rr.Result ? [rr.Result] : [];
        for (const r of resultBlocks) {
          const resulttime = toSeconds(r?.Time);
          const resulttimediff = toSeconds(r?.TimeDiff);
          const resultposition = r?.ResultPosition != null ? parseInt(r.ResultPosition, 10) : null;
          const resultcompetitorstatus = r?.CompetitorStatus?.['@_value'] ?? null;

          // VIKTIGT: Ingen classresultnumberofstarts i multiday.
          // Vi inkluderar inte nyckeln i objektet överhuvudtaget.
          const row = {
            personid: personId,
            eventid: eventId != null ? parseInt(eventId, 10) : null,
            eventraceid: eventRaceId,
            eventclassname: eventClassName,
            resulttime,
            resulttimediff,
            resultposition,
            resultcompetitorstatus,
            // classresultnumberofstarts: (UTELÄMNAD MEDVETET)
            classtypeid: classTypeId,
            klassfaktor,
            points: null, // Poäng räknas inte här i MultiDay (kan läggas till senare om du vill)
            personage,
            organisationid: organisationId,
            clubparticipation: clubId,
            batchid: batchId
          };

          results.push(row);
        }
      }
    }
  }

  console.log(`[parseResultsMultiDay] Totalt antal resultat: ${results.length}`);
  return { results, warnings };
}

module.exports = parseResultsMultiDay;
