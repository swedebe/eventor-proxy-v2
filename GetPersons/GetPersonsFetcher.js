const axios = require('axios');

async function fetchPersonsFromEventor(organisationId, apiKey) {
  const url = `https://eventor.orientering.se/api/persons/organisations/${organisationId}`;
  const headers = { ApiKey: apiKey };

  try {
    const response = await axios.get(url, { headers, responseType: 'text' });
    return { status: response.status, data: response.data };
  } catch (error) {
    return {
      status: error.response?.status || 500,
      error: error.message || 'Unknown error',
    };
  }
}

module.exports = { fetchPersonsFromEventor };
