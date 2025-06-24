const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const batchRouter = require('./routes/batch');

dotenv.config();

const app = express();
const PORT = process.env.PORT; // Obligatoriskt för Render

app.use(express.json());

// Batch-endpoint (vår egen kod)
app.use('/batch', batchRouter);

// Proxy mot Eventor API
app.get('/api/*', async (req, res) => {
  const path = req.originalUrl.replace('/api', '');
  const url = `https://eventor.orientering.se/api${path}`;
  const apiKey = req.query.apiKey || process.env.EVENTOR_API_KEY;

  if (!apiKey) {
    return res.status(400).send('Missing API key');
  }

  try {
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

// Starta servern
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
