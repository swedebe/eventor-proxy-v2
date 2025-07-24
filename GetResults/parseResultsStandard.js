const { XMLParser } = require("fast-xml-parser");

function parseResultsStandard(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: true
  });

  const parsed = parser.parse(xmlString);

  if (!parsed || !parsed.ResultList || !parsed.ResultList.ClassResult) return [];

  const classResults = Array.isArray(parsed.ResultList.ClassResult)
    ? parsed.ResultList.ClassResult
    : [parsed.ResultList.ClassResult];

  const output = [];

  for (const classResult of classResults) {
    const eventClass = classResult.EventClass?.Name;
    const classStarts = parseInt(classResult.ClassRaceInfo?.noOfStarts ?? 0, 10);
    const classTypeId = getClassTypeId(eventClass);
    const klassfaktor = getKlassFaktor(eventClass);

    const results = Array.isArray(classResult.PersonResult)
      ? classResult.PersonResult
      : [classResult.PersonResult];

    for (const result of results) {
      if (!result || !result.Person || !result.Person.PersonId) continue;

      const row = {
        personid: parseInt(result.Person.PersonId),
        eventid: parseInt(parsed.ResultList.Event.EventId),
        eventraceid: parseInt(classResult.EventClass?.ClassRaceInfo?.EventRaceId ?? 0),
        eventclassname: eventClass,
        resulttime: toSeconds(result.Result?.Time),
        resulttimediff: toSeconds(result.Result?.TimeDiff),
        resultposition: toIntOrNull(result.Result?.ResultPosition),
        resultcompetitorstatus: result.Result?.CompetitorStatus?.value ?? null,
        classresultnumberofstarts: classStarts,
        classtypeid: classTypeId,
        klassfaktor: klassfaktor,
        points: toFloatOrNull(result.Result?.Points),
        personage: toIntOrNull(result.Person?.Age),
        organisationid: parseInt(result.Organisation?.OrganisationId ?? 0)
      };

      output.push(row);
    }
  }

  return output;
}

// === Hjälpfunktioner ===

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

function toIntOrNull(v) {
  const n = parseInt(v);
  return isNaN(n) ? null : n;
}

function toFloatOrNull(v) {
  const f = parseFloat(v);
  return isNaN(f) ? null : f;
}

function getClassTypeId(name) {
  if (!name) return null;
  if (name.match(/^(H|D|Open|Motion|Inskolning|U|Ö|N)/)) return 17;
  if (name.match(/^(Blå|Grön|Gul|Orange|Svart)/)) return 19;
  return null;
}

function getKlassFaktor(name) {
  if (!name) return null;
  if (name.match(/^(Blå|Orange|Grön|Gul|Svart)/)) return 75;
  return 100;
}

module.exports = parseResultsStandard;
