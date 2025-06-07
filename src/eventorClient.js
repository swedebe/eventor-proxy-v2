const axios = require("axios");
const xml2js = require("xml2js");

const parser = new xml2js.Parser({ explicitArray: false });

async function getResultsForEvent(organisationId, eventId) {
  const url = `https://eventor.orientering.se/api/results/organisation?organisationIds=${organisationId}&eventId=${eventId}`;
  const headers = { apiKey: process.env.EVENTOR_API_KEY };

  const response = await axios.get(url, { headers });
  const parsed = await parser.parseStringPromise(response.data);

  const results = [];

  const classResults = parsed.ResultList?.ClassResult || [];
  const classes = Array.isArray(classResults) ? classResults : [classResults];

  for (const cls of classes) {
    const className = cls.EventClass?.Name;
    const classTypeId = parseInt(cls.EventClass?.ClassTypeId) || null;
    const numberOfStarts = parseInt(cls?.PersonResult?.length ? cls.PersonResult.length : cls?.NumberOfStarts) || null;

    const personResults = cls.PersonResult || [];
    const resultsArray = Array.isArray(personResults) ? personResults : [personResults];

    for (const pr of resultsArray) {
      const person = pr.Person || {};
      const organisation = person.Organisation || pr.Organisation || {};
      const birthDate = person?.BirthDate || null;

      results.push({
        PersonId: person?.Id,
        EventId: parseInt(eventId),
        EventRaceId: null, // måste mappas via events-tabellen senare om du vill
        EventClass_Name: className,
        Result_Time: pr.Result?.Time,
        Result_TimeDiff: pr.Result?.TimeDiff,
        ResultPosition: parseInt(pr.Result?.Position) || null,
        Result_CompetitorStatus: pr.Result?.CompetitorStatus,
        ClassResult_numberOfStarts: numberOfStarts,
        ClassTypeId: classTypeId,
        Person_BirthDate: birthDate,
        TillhörandeOrganisationId: parseInt(organisation?.Id) || null
      });
    }
  }

  return results;
}

module.exports = {
  getResultsForEvent
};
