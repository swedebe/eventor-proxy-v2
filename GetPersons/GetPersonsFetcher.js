// GetPersonsFetcher.js
const axios = require('axios');

export async function fetchPersons(organisationId, apiKey) {
  const url = `https://eventor.orientering.se/api/persons/organisations/${organisationId}`;
  const headers = {
    'ApiKey': apiKey,
    'Accept': 'application/json'
  };

  try {
    const response = await axios.get(url, { headers });
    return { success: true, data: response.data, url, status: response.status };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      url,
      status: error.response?.status || null
    };
  }
}
