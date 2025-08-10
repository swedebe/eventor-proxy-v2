// server.js
// Full server wiring, including autorun of persons batch at startup (disable with AUTO_RUN_PERSONS_ON_START=false).

const express = require('express');
const dotenv = require('dotenv');
const axios = require('axios');
const xml2js = require('xml2js');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();
const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Routers
let getEventsRouter;
let getResultsRouter;
let getEventsTestRouter;
let getPersonsRouter;

try { getEventsRouter = require('./GetEvents/GetEventsRouter.js'); } catch {}
try { getResultsRouter = require('./GetResults/GetResultsRouter.js'); } catch {}
try { getEventsTestRouter = require('./GetEvents/GetEventsTestRouter.js'); } catch {}
try { getPersonsRouter = require('./GetPersons/GetPersonsRouter.js'); } catch {}

// Mount under /api (only if present)
if (getEventsRouter) app.use('/api', getEventsRouter);
if (getResultsRouter) app.use('/api', getResultsRouter);
if (getEventsTestRouter) app.use('/api', getEventsTestRouter);
if (getPersonsRouter) app.use('/api', getPersonsRouter);

// Health
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, time: new Date().toISOString() });
});

// Simple proxy for debugging Eventor responses (optional)
app.get('/api/proxy', async (req, res) => {
  try {
    const { target } = req.query;
    if (!target) return res.status(400).json({ error: 'Missing target query param' });

    const response = await axios.get(target, {
      headers: {
        ApiKey: process.env.EVENTOR_API_KEY || process.env.EventorApiKey,
        Accept: 'application/xml',
      }
    });

    res.set('Content-Type', 'application/xml');
    res.status(200).send(response.data);
  } catch (err) {
    console.error('[Proxy error]', err.message);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Servern kör på port ${PORT}`);
});

// Autorun persons batch across clubs at startup (with job protection)
const autorun = String(process.env.AUTO_RUN_PERSONS_ON_START || 'true').toLowerCase() !== 'false';
if (autorun) {
  setTimeout(async () => {
    try {
      console.log('[Startup] Auto-run GetPersons batch across clubs...');
      const { runGetPersonsForAllClubs } = require('./GetPersons/GetPersonsRunner');
      const result = await runGetPersonsForAllClubs({ pauseMs: 600 });
      console.log('[Startup] Auto-run finished:', result);
    } catch (e) {
      console.error('[Startup] Auto-run failed:', e?.message || e);
    }
  }, 3000);
}

module.exports = server;
