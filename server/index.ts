import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = express()
const port = Number(process.env.PORT ?? 3001)
const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const clientBuildDirectory = path.resolve(currentDirectory, '../dist')

app.use(express.json())

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', service: 'boardmeetings-api' })
})

app.use(express.static(clientBuildDirectory))

app.get('/{*path}', (_request, response, next) => {
  response.sendFile(path.join(clientBuildDirectory, 'index.html'), (error) => {
    if (error) next(error)
  })
})

app.listen(port, () => {
  console.log(`BoardMeetings server listening on http://localhost:${port}`)
})
