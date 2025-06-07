const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const batchRouter = require('./routes/batch');

dotenv.config();

const app = express();
app.use(express.json());

// Registrera batch-routes
app.use("/batch", batchRouter);

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

// Global fångst av async-fel (med bättre loggning)
process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED REJECTION:");
  try {
    console.error(JSON.stringify(reason, null, 2));
  } catch {
    console.error(reason);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
