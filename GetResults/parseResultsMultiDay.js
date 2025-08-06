function parseTimeToSeconds(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function parseResults(xml, eventId, clubId, batchId, eventdate) {
  const results = [];
  const warnings = [];

  const classResults = Array.isArray(xml.ResultList.ClassResult)
    ? xml.ResultList.ClassResult
    : [xml.ResultList.ClassResult];

  for (const classResult of classResults) {
    const eventClass = classResult.EventClass;
    const eventClassName = eventClass?.Name || null;
    const classTypeId = Number(eventClass?.ClassTypeId) || 0;

    if (classTypeId === 0 && eventClassName) {
      warnings.push(`[parseResultsMultiDay][Warning] Okänd klass: "${eventClassName}" => classtypeid sätts till 0`);
    }

    const klassfaktor =
      classTypeId === 16 ? 125 :
      classTypeId === 17 ? 100 :
      classTypeId === 19 ? 75 :
      null;

    const classRaceInfo = Array.isArray(classResult.ClassRaceInfo)
      ? classResult.ClassRaceInfo[0]
      : classResult.ClassRaceInfo;
    const classresultnumberofstarts = classRaceInfo?.noOfStarts
      ? Number(classRaceInfo.noOfStarts)
      : null;

    const personResults = Array.isArray(classResult.PersonResult)
      ? classResult.PersonResult
      : [classResult.PersonResult];

    for (const personResult of personResults) {
      const personId = Number(personResult?.Person?.PersonId?.id);
      const birthDate = personResult?.Person?.BirthDate?.Date;
      const birthYear = birthDate ? parseInt(birthDate.split('-')[0]) : null;
      const eventYear = parseInt(eventdate.split('-')[0]);
      const personage = birthYear ? eventYear - birthYear : null;

      const resultBlock = personResult.Result;

      if (!resultBlock) continue;

      const resultsArray = Array.isArray(resultBlock) ? resultBlock : [resultBlock];

      for (const r of resultsArray) {
        const status = r.CompetitorStatus?.value || null;
        if (status !== 'OK') continue;

        const eventRaceId = Number(r.EventRaceId);
        if (!eventRaceId || !personId) continue;

        const resulttime = parseTimeToSeconds(r.Time);
        const resulttimediff = parseTimeToSeconds(r.TimeDiff);
        const resultposition = r.Position ? Number(r.Position) : null;

        const points = (klassfaktor && resultposition && classresultnumberofstarts)
          ? Math.round((klassfaktor * (1 - (resultposition / classresultnumberofstarts))) * 100) / 100
          : null;

        results.push({
          personid: personId,
          eventid: eventId,
          eventraceid: eventRaceId,
          eventclassname: eventClassName,
          resulttime,
          resulttimediff,
          resultposition,
          resultcompetitorstatus: status,
          classresultnumberofstarts,
          classtypeid: classTypeId,
          klassfaktor,
          points,
          personage,
          batchid: batchId,
          clubparticipation: clubId
        });
      }
    }
  }

  console.log(`[parseResultsMultiDay] Antal resultatrader: ${results.length}`);
  return { results, warnings };
}

module.exports = parseResults;
