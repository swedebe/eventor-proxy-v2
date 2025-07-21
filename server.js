const express = require('express');
const dotenv = require('dotenv');
const getEventsRouter = require('./GetEvents/GetEventsRouter');
const getResultsRouter = require('./GetResults/GetResultsRouter');

dotenv.config();

const app = express();
const PORT = process.env.PORT;

app.use(express.json());

// Endpoints för GetEvents och GetResults
app.use('/api', getEventsRouter);
app.use('/api', getResultsRouter);

// Eventor-proxy (måste ligga efter interna endpoints)
app.get('/api/*', async (req, res) => {
  const path = req.originalUrl.replace('/api', '');
  const url = `https://eventor.orientering.se/api${path}`;
  const apiKey = req.query.apiKey || process.env.EVENTOR_API_KEY;

  if (!apiKey) {
    return res.status(400).send('Missing API key');
  }

  try {
    const axios = require('axios');
    const response = await axios.get(url, {
      headers: { ApiKey: apiKey },
      responseType: 'text',
    });

    res.set('Content-Type', 'application/xml');
    res.status(response.status).send(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).send(error.message);
  }
});

// Hälso-check
app.get('/', (req, res) => {
  res.send('Eventor proxy is running.');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
