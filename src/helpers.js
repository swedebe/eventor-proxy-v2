function validateApiKey(apiKey) {
  return apiKey && apiKey === process.env.INTERNAL_API_KEY;
}

function formatDate(date) {
  return date.toISOString().split("T")[0];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  validateApiKey,
  formatDate,
  sleep
};
