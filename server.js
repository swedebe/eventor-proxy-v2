import express from 'express'
import axios from 'axios'
import dotenv from 'dotenv'
dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

app.get('/api/*', async (req, res) => {
  const path = req.originalUrl.replace('/api', '')
  const url = `https://eventor.orientering.se/api${path}`

  const apiKey = req.query.apiKey || process.env.API_KEY
  if (!apiKey) return res.status(400).send('Missing API key')

  try {
    const response = await axios.get(url, {
      headers: { ApiKey: apiKey },
      responseType: 'text'
    })
    res.set('Content-Type', 'application/xml')
    res.status(response.status).send(response.data)
  } catch (error) {
    res.status(error.response?.status || 500).send(error.message)
  }
})

app.get('/', (req, res) => {
  res.send('Eventor proxy is running.')
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
