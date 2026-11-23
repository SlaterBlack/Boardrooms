import 'dotenv/config'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BoardroomEvent, ProviderAvailability } from '../shared/boardroom.ts'
import {
  clearSessionCookie,
  createSessionCookie,
  hasValidSession,
  matchesAccessPassword,
} from './auth.ts'
import { BoardroomInputError, parseBoardroomInput, runBoardroom } from './boardroom.ts'

const app = express()
const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '127.0.0.1'
const accessPassword = process.env.BOARDMEETINGS_PASSWORD?.trim() ?? ''
const secureCookies = process.env.COOKIE_SECURE === 'true'
const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const clientBuildDirectory = path.resolve(currentDirectory, '../dist')

function isLoopbackHost(value: string): boolean {
  return value === 'localhost' || value === '127.0.0.1' || value === '::1'
}

if (!isLoopbackHost(host) && accessPassword.length < 16) {
  throw new Error('BOARDMEETINGS_PASSWORD must contain at least 16 characters for network access.')
}

const loginAttempts = new Map<string, { count: number; resetAt: number }>()

app.use(express.json({ limit: '64kb' }))

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', service: 'boardmeetings-api' })
})

app.get('/api/auth/session', (request, response) => {
  const authenticated =
    (!accessPassword && isLoopbackHost(host)) ||
    (accessPassword.length > 0 &&
      hasValidSession(request.headers.cookie, accessPassword))

  if (!authenticated) {
    response.status(401).json({ error: 'Sign in to access this boardroom.' })
    return
  }

  response.set('Cache-Control', 'no-store').json({ authenticated: true })
})

app.post('/api/auth/login', (request, response) => {
  if (accessPassword.length < 16) {
    response.status(503).json({ error: 'Network access is not configured on this server.' })
    return
  }

  const remoteAddress = request.ip || request.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const attempt = loginAttempts.get(remoteAddress)
  if (attempt && attempt.resetAt > now && attempt.count >= 8) {
    response
      .set('Retry-After', String(Math.ceil((attempt.resetAt - now) / 1000)))
      .status(429)
      .json({ error: 'Too many sign-in attempts. Try again later.' })
    return
  }

  const candidate = request.body?.password
  if (
    typeof candidate !== 'string' ||
    candidate.length > 512 ||
    !matchesAccessPassword(candidate, accessPassword)
  ) {
    const current =
      attempt && attempt.resetAt > now
        ? attempt
        : { count: 0, resetAt: now + 15 * 60 * 1000 }
    current.count += 1
    loginAttempts.set(remoteAddress, current)
    response.status(401).json({ error: 'Incorrect access password.' })
    return
  }

  loginAttempts.delete(remoteAddress)
  response
    .set('Cache-Control', 'no-store')
    .set('Set-Cookie', createSessionCookie(accessPassword, now, secureCookies))
    .json({ authenticated: true })
})

app.post('/api/auth/logout', (_request, response) => {
  response
    .set('Set-Cookie', clearSessionCookie(secureCookies))
    .json({ authenticated: false })
})

app.use('/api', (request, response, next) => {
  const authenticated =
    (!accessPassword && isLoopbackHost(host)) ||
    (accessPassword.length > 0 &&
      hasValidSession(request.headers.cookie, accessPassword))

  if (authenticated) {
    next()
    return
  }
  response.status(401).json({ error: 'Sign in to access this boardroom.' })
})

app.get('/api/providers', (_request, response) => {
  const availability: ProviderAvailability = {
    openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
  }
  response.json({ providers: availability })
})

app.post('/api/boardrooms/run', async (request, response) => {
  let input
  try {
    input = parseBoardroomInput(request.body)
  } catch (error) {
    if (error instanceof BoardroomInputError) {
      response.status(400).json({ error: error.message })
      return
    }
    throw error
  }

  const missingProviders = [
    ...new Set(
      input.agents
        .filter((agent) =>
          agent.provider === 'openai'
            ? !process.env.OPENAI_API_KEY?.trim()
            : !process.env.ANTHROPIC_API_KEY?.trim(),
        )
        .map((agent) => agent.provider),
    ),
  ]
  if (missingProviders.length > 0) {
    const instructions = missingProviders
      .map((provider) =>
        provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY',
      )
      .join(' and ')
    response.status(503).json({
      error: `Configure ${instructions} in the server environment, then restart the service.`,
    })
    return
  }

  response.status(200).set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  })

  const controller = new AbortController()
  response.on('close', () => {
    if (!response.writableEnded) controller.abort()
  })

  const emit = (event: BoardroomEvent) => {
    if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`)
  }

  try {
    await runBoardroom(input, emit, controller.signal)
    if (!response.writableEnded) response.end()
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) return
    const message =
      error instanceof Error ? error.message : 'The boardroom run failed.'
    emit({ type: 'error', message })
    response.end()
  }
})

app.use(express.static(clientBuildDirectory))

app.get('/{*path}', (_request, response, next) => {
  response.sendFile(path.join(clientBuildDirectory, 'index.html'), (error) => {
    if (error) next(error)
  })
})

app.listen(port, host, () => {
  console.log(`BoardMeetings server listening on http://${host}:${port}`)
})
