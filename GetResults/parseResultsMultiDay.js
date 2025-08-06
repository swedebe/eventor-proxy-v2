// GetResults/parseResultsMultiDay.js
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

  const classes = Array.isArray(xml.ResultList.ClassResult)
    ? xml.ResultList.ClassResult
    : [xml.ResultList.ClassResult];

  for (const classResult of classes) {
    const eventClass = classResult.EventClass;
    if (!eventClass || !eventClass.EventClassId) continue;

    const eventClassName = eventClass.Name;
    const eventClassId = eventClass.EventClassId;
    const classTypeId = Number(eventClass.ClassTypeId) || 0;

    if (classTypeId === 0) {
      warnings.push(`[parseResultsMultiDay][Warning] Okänd klass: "${eventClassName}" => classtypeid sätts till 0`);
    }

    const klassfaktor =
      classTypeId === 16 ? 125 :
      classTypeId === 17 ? 100 :
      classTypeId === 19 ? 75 :
      null;

    const classresultnumberofstarts = Number(classResult.numberOfStarts) || null;

    const classRaceInfos = Array.isArray(eventClass.ClassRaceInfo)
      ? eventClass.ClassRaceInfo
      : [eventClass.ClassRaceInfo];

    const eventRaceIds = classRaceInfos.map(cr => Number(cr?.EventRaceId)).filter(Boolean);

    const persons = Array.isArray(classResult.PersonResult)
      ? classResult.PersonResult
      : [classResult.PersonResult];

    for (const personResult of persons) {
      const person = personResult.Person;
      const personId = Number(person?.PersonId);
      const sex = person?.sex || null;
      const birthYear = person?.BirthDate?.Date?.split('-')[0];
      const personage = birthYear ? Number(eventdate.split('-')[0]) - Number(birthYear) : null;

      const races = Array.isArray(personResult.RaceResult)
        ? personResult.RaceResult
        : [personResult.RaceResult];

      for (const raceResult of races) {
        const eventRaceId = Number(raceResult?.EventRaceId);
        if (!eventRaceIds.includes(eventRaceId)) continue;

        const result = raceResult.Result;
        if (!result || result.CompetitorStatus?.value !== 'OK') continue;

        const resulttime = parseTimeToSeconds(result.Time);
        const resulttimediff = parseTimeToSeconds(result.TimeDiff);
        const resultposition = Number(result.ResultPosition);

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
          resultcompetitorstatus: result.CompetitorStatus?.value || null,
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
