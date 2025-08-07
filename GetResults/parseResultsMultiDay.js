const { XMLParser } = require("fast-xml-parser");

function parseResultsMultiDay(xmlString, eventId, organisationId, batchId, eventdate) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: true
  });

  const parsed = parser.parse(xmlString);

  const results = [];
  const personResultCount = {};

  const classResults = Array.isArray(parsed?.ResultList?.ClassResult)
    ? parsed.ResultList.ClassResult
    : [parsed?.ResultList?.ClassResult].filter(Boolean);

  for (const classResult of classResults) {
    const eventClass = classResult?.EventClass;
    const eventClassName = eventClass?.Name || null;
    const classTypeId = parseInt(eventClass?.ClassTypeId || '0');

    const klassfaktor =
      classTypeId === 16 ? 125 :
      classTypeId === 17 ? 100 :
      classTypeId === 19 ? 75 :
      null;

    const personResults = Array.isArray(classResult.PersonResult)
      ? classResult.PersonResult
      : [classResult.PersonResult].filter(Boolean);

    for (const personResult of personResults) {
      const personId = parseInt(personResult?.Person?.PersonId || '0');
      if (!personId) continue;

      const organisation = personResult?.Organisation;
      const organisationIdFromResult = parseInt(organisation?.OrganisationId || '0');

      const raceResults = Array.isArray(personResult?.RaceResult)
        ? personResult.RaceResult
        : [personResult?.RaceResult].filter(Boolean);

      for (const raceResult of raceResults) {
        const result = raceResult?.Result;
        if (!result || result?.CompetitorStatus?.value !== 'OK') continue;

        const eventRaceId = parseInt(raceResult?.EventRaceId || '0');
        const resulttime = toSeconds(result?.Time);
        const resulttimediff = toSeconds(result?.TimeDiff);
        const resultposition = parseInt(result?.ResultPosition || '0');

        const numberOfStarts = null; // enligt instruktion, dessa värden kan ej användas

        const points = (klassfaktor && resultposition && numberOfStarts)
          ? Math.round((klassfaktor * (1 - (resultposition / numberOfStarts))) * 100) / 100
          : null;

        const birthDate = personResult?.Person?.BirthDate?.Date;
        const birthYear = birthDate ? parseInt(birthDate.split('-')[0]) : null;
        const eventYear = eventdate ? parseInt(eventdate.split('-')[0]) : null;
        const personage = (birthYear && eventYear) ? eventYear - birthYear : null;

        const row = {
          personid: personId,
          eventid: eventId,
          eventraceid: eventRaceId,
          eventclassname: eventClassName,
          resulttime,
          resulttimediff,
          resultposition,
          resultcompetitorstatus: result?.CompetitorStatus?.value || null,
          classresultnumberofstarts: numberOfStarts,
          classtypeid: classTypeId,
          klassfaktor,
          points,
          personage,
          batchid: batchId,
          clubparticipation: organisationId
        };

        results.push(row);

        if (!personResultCount[personId]) personResultCount[personId] = 0;
        personResultCount[personId]++;
      }
    }
  }

  console.log(`[parseResultsMultiDay] Totalt ${results.length} resultat hittades.`);
  for (const [personId, count] of Object.entries(personResultCount)) {
    console.log(`[parseResultsMultiDay] Person ${personId} hade ${count} resultat.`);
  }

  return { results, warnings: [] };
}

function toSeconds(value) {
  if (typeof value === 'string' && value.includes(':')) {
    const parts = value.split(':').map((v) => parseInt(v));
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  } else if (typeof value === 'number') {
    return value;
  } else {
    return null;
  }
}

module.exports = parseResultsMultiDay;
