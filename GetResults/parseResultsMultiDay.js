const { XMLParser } = require("fast-xml-parser");

function parseResultsMultiDay(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: true
  });

  const parsed = parser.parse(xmlString);

  if (!parsed || !parsed.ResultList) {
    console.warn('[parseResultsMultiDay] Ingen ResultList i XML');
    return [];
  }

  console.log('[parseResultsMultiDay] XML-parsing lyckades, loggar hela ResultList:');
  console.log(JSON.stringify(parsed.ResultList, null, 2));

  if (!parsed.ResultList.ClassResult) {
    console.warn('[parseResultsMultiDay] ResultList finns men saknar ClassResult');
    return [];
  }

  const classResults = Array.isArray(parsed.ResultList.ClassResult)
    ? parsed.ResultList.ClassResult
    : [parsed.ResultList.ClassResult];

  const output = [];

  for (const classResult of classResults) {
    const eventClass = classResult.EventClass?.Name;
    const classStarts = parseInt(classResult.ClassRaceInfo?.NumberOfStarts ?? 0, 10);
    const classTypeId = getClassTypeId(eventClass);
    const klassfaktor = getKlassFaktor(eventClass);

    const results = Array.isArray(classResult.PersonResult)
      ? classResult.PersonResult
      : classResult.PersonResult ? [classResult.PersonResult] : [];

    for (const result of results) {
      const resultBlocks = Array.isArray(result.Result)
        ? result.Result
        : result.Result ? [result.Result] : [];

      for (const r of resultBlocks) {
        const eventRaceId = parseInt(r?.EventRaceId ?? 0, 10);
        if (!r || !eventRaceId) continue;

        const row = {
          personid: parseInt(result.Person?.PersonId?.['@_id'] ?? 0),
          eventid: parseInt(parsed.ResultList.Event.EventId),
          eventraceid: eventRaceId,
          eventclassname: eventClass,
          resulttime: toSeconds(r.Time),
          resulttimediff: toSeconds(r.TimeDiff),
          resultposition: toIntOrNull(r.Position),
          resultcompetitorstatus: r.CompetitorStatus?.['@_value'] ?? null,
          classresultnumberofstarts: classStarts,
          classtypeid: classTypeId,
          klassfaktor: klassfaktor,
          points: toFloatOrNull(r.Points),
          personage: toIntOrNull(result.Person?.Age),
          organisationid: parseInt(result.Organisation?.OrganisationId ?? 0)
        };

        output.push(row);
      }
    }
  }

  console.log(`[parseResultsMultiDay] Antal resultatrader: ${output.length}`);
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

module.exports = parseResultsMultiDay;
