import type {
  BoardroomEvent,
  BoardroomReportEvent,
  BoardroomReportInput,
  BoardroomRunInput,
  BoardroomTurn,
} from '../shared/boardroom'
import { isBoardroomImageSource } from '../shared/chat'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readEvent(value: unknown): BoardroomEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Received an invalid event from the boardroom.')
  }

  if (
    value.type === 'round_start' &&
    typeof value.round === 'number' &&
    typeof value.totalRounds === 'number'
  ) {
    return { type: value.type, round: value.round, totalRounds: value.totalRounds }
  }
  if (
    (value.type === 'route_start' || value.type === 'route_complete') &&
    typeof value.agentId === 'string' &&
    typeof value.agentName === 'string'
  ) {
    return {
      type: value.type,
      agentId: value.agentId,
      agentName: value.agentName,
    }
  }
  if (
    value.type === 'turn_start' &&
    typeof value.agentId === 'string' &&
    typeof value.agentName === 'string' &&
    typeof value.round === 'number'
  ) {
    return {
      type: value.type,
      agentId: value.agentId,
      agentName: value.agentName,
      round: value.round,
    }
  }
  if (
    value.type === 'turn_delta' &&
    typeof value.turnId === 'string' &&
    typeof value.agentId === 'string' &&
    typeof value.agentName === 'string' &&
    typeof value.agentRole === 'string' &&
    typeof value.round === 'number' &&
    typeof value.delta === 'string'
  ) {
    return {
      type: value.type,
      turnId: value.turnId,
      agentId: value.agentId,
      agentName: value.agentName,
      agentRole: value.agentRole,
      round: value.round,
      delta: value.delta,
    }
  }
  if (value.type === 'turn_complete' && isRecord(value.turn)) {
    const turn = value.turn
    if (
      typeof turn.id === 'string' &&
      typeof turn.agentId === 'string' &&
      typeof turn.agentName === 'string' &&
      typeof turn.agentRole === 'string' &&
      typeof turn.round === 'number' &&
      typeof turn.content === 'string' &&
      (turn.imageUrl === undefined || isBoardroomImageSource(turn.imageUrl))
    ) {
      const parsedTurn: BoardroomTurn = {
        id: turn.id,
        agentId: turn.agentId,
        agentName: turn.agentName,
        agentRole: turn.agentRole,
        round: turn.round,
        content: turn.content,
        ...(typeof turn.imageUrl === 'string' ? { imageUrl: turn.imageUrl } : {}),
      }
      return { type: value.type, turn: parsedTurn }
    }
  }
  if (
    value.type === 'synthesis_start' &&
    typeof value.messageId === 'string' &&
    typeof value.agentId === 'string' &&
    typeof value.agentName === 'string'
  ) {
    return {
      type: value.type,
      messageId: value.messageId,
      agentId: value.agentId,
      agentName: value.agentName,
    }
  }
  if (
    value.type === 'synthesis_delta' &&
    typeof value.messageId === 'string' &&
    typeof value.delta === 'string'
  ) {
    return { type: value.type, messageId: value.messageId, delta: value.delta }
  }
  if (
    value.type === 'synthesis_complete' &&
    typeof value.messageId === 'string' &&
    typeof value.agentId === 'string' &&
    typeof value.agentName === 'string' &&
    typeof value.content === 'string'
  ) {
    return {
      type: value.type,
      messageId: value.messageId,
      agentId: value.agentId,
      agentName: value.agentName,
      content: value.content,
    }
  }
  if (value.type === 'chat_memory_start') {
    return { type: value.type }
  }
  if (value.type === 'chat_memory_update' && typeof value.summary === 'string') {
    return { type: value.type, summary: value.summary }
  }
  if (value.type === 'chat_memory_error' && typeof value.message === 'string') {
    return { type: value.type, message: value.message }
  }
  if (value.type === 'error' && typeof value.message === 'string') {
    return { type: value.type, message: value.message }
  }
  if (value.type === 'done') return { type: value.type }

  throw new Error('Received an invalid event from the boardroom.')
}

function readReportEvent(value: unknown): BoardroomReportEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Received an invalid event while generating the report.')
  }
  if (
    (value.type === 'section_start' || value.type === 'section_complete') &&
    typeof value.agentId === 'string' &&
    typeof value.agentName === 'string'
  ) {
    return {
      type: value.type,
      agentId: value.agentId,
      agentName: value.agentName,
    }
  }
  if (
    value.type === 'facilitator_start' &&
    typeof value.agentId === 'string' &&
    typeof value.agentName === 'string'
  ) {
    return {
      type: value.type,
      agentId: value.agentId,
      agentName: value.agentName,
    }
  }
  if (value.type === 'report_complete' && typeof value.content === 'string') {
    return { type: value.type, content: value.content }
  }
  if (value.type === 'error' && typeof value.message === 'string') {
    return { type: value.type, message: value.message }
  }
  if (value.type === 'done') return { type: value.type }

  throw new Error('Received an invalid event while generating the report.')
}

async function responseError(response: Response): Promise<string> {
  const result: unknown = await response.json().catch(() => null)
  if (isRecord(result) && typeof result.error === 'string') return result.error
  return `The boardroom request failed (${response.status}).`
}

export async function streamBoardroom(
  input: BoardroomRunInput,
  signal: AbortSignal,
  onEvent: (event: BoardroomEvent) => void,
): Promise<void> {
  const response = await fetch('/api/boardrooms/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  })

  if (!response.ok) throw new Error(await responseError(response))
  if (!response.body) throw new Error('The boardroom stream is unavailable.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  function processLine(line: string) {
    if (line.trim()) onEvent(readEvent(JSON.parse(line) as unknown))
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    lines.forEach(processLine)
    if (done) break
  }
  processLine(buffer)
}

export async function streamBoardroomReport(
  input: BoardroomReportInput,
  signal: AbortSignal,
  onEvent: (event: BoardroomReportEvent) => void,
): Promise<void> {
  const response = await fetch('/api/boardrooms/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  })

  if (!response.ok) throw new Error(await responseError(response))
  if (!response.body) throw new Error('The boardroom report stream is unavailable.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  function processLine(line: string) {
    if (line.trim()) onEvent(readReportEvent(JSON.parse(line) as unknown))
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    lines.forEach(processLine)
    if (done) break
  }
  processLine(buffer)
}
