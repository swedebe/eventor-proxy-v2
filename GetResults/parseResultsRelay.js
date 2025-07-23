const { XMLParser } = require("fast-xml-parser");

function parseResultsRelay(xmlString) {
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
    const classStarts = parseInt(classResult.ClassRaceInfo?.NumberOfStarts ?? 0, 10);
    const classTypeId = getClassTypeId(eventClass);
    const klassfaktor = getKlassFaktor(eventClass);

    const teamResults = Array.isArray(classResult.TeamResult)
      ? classResult.TeamResult
      : classResult.TeamResult ? [classResult.TeamResult] : [];

    for (const team of teamResults) {
      const legs = Array.isArray(team.Leg)
        ? team.Leg
        : team.Leg ? [team.Leg] : [];

      for (const leg of legs) {
        const row = {
          personid: parseInt(leg.Person?.PersonId?.['@_id'] ?? 0),
          eventid: parseInt(parsed.ResultList.Event.EventId),
          eventraceid: parseInt(leg.EventRaceId),
          eventclassname: eventClass,
          resulttime: toSeconds(leg.Time),
          resulttimediff: toSeconds(leg.TimeDiff),
          resultposition: toIntOrNull(leg.Position),
          resultcompetitorstatus: leg.CompetitorStatus?.['@_value'] ?? null,
          classresultnumberofstarts: classStarts,
          classtypeid: classTypeId,
          klassfaktor: klassfaktor,
          points: toFloatOrNull(leg.Points),
          personage: toIntOrNull(leg.Person?.Age),
          organisationid: parseInt(leg.Organisation?.OrganisationId ?? 0)
        };

        output.push(row);
      }
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

module.exports = parseResultsRelay;
