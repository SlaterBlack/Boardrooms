import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentConfig,
  BoardroomChatMessage,
  BoardroomReport,
  BoardroomTurn,
  ChatType,
  Meeting,
  MeetingMode,
  MeetingStatus,
  Provider,
} from '../shared/boardroom.ts'
import {
  isBoardroomImageSource,
  normalizeChatAgentRoles,
  normalizeDefaultChatRole,
  normalizeModelCapabilities,
} from '../shared/chat.ts'

const stateDirectory =
  process.env.BOARDROOMS_DATA_DIR?.trim() ||
  path.resolve(process.cwd(), '.boardrooms-data')
const stateFile = path.join(stateDirectory, 'state.json')

export interface BoardroomState {
  revision: number
  agents: AgentConfig[]
  meetings: Meeting[]
}

export interface BoardroomStatePatch {
  agents?: AgentConfig[]
  meetings?: Meeting[]
}

export class BoardroomStateInputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readAgent(value: unknown): AgentConfig | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    value.id.length > 80 ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 80 ||
    typeof value.role !== 'string' ||
    !value.role.trim() ||
    value.role.length > 120 ||
    (value.provider !== 'openai' &&
      value.provider !== 'anthropic' &&
      value.provider !== 'openrouter' &&
      value.provider !== 'magnific') ||
    typeof value.model !== 'string' ||
    !value.model.trim() ||
    value.model.length > 120 ||
    typeof value.knowledge !== 'string' ||
    value.knowledge.length > 1_200 ||
    typeof value.skills !== 'string' ||
    value.skills.length > 1_200 ||
    typeof value.instructions !== 'string' ||
    value.instructions.length > 2_000
  ) {
    return null
  }

  const defaultChatRole = normalizeDefaultChatRole(value.defaultChatRole)
  const modelCapabilities = normalizeModelCapabilities(value.modelCapabilities)
  if (!defaultChatRole || !modelCapabilities) return null
  const provider: Provider = value.provider
  return {
    id: value.id,
    name: value.name,
    role: value.role,
    defaultChatRole,
    modelCapabilities,
    provider,
    model: value.model,
    knowledge: value.knowledge,
    skills: value.skills,
    instructions: value.instructions,
  }
}

function readTurn(value: unknown): BoardroomTurn | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.agentId !== 'string' ||
    typeof value.agentName !== 'string' ||
    typeof value.agentRole !== 'string' ||
    typeof value.round !== 'number' ||
    !Number.isInteger(value.round) ||
    value.round < 1 ||
    value.round > 3 ||
    typeof value.content !== 'string'
  ) {
    return null
  }

  return {
    id: value.id,
    agentId: value.agentId,
    agentName: value.agentName,
    agentRole: value.agentRole,
    round: value.round,
    content: value.content,
  }
}

function readChatMessage(value: unknown): BoardroomChatMessage | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    value.id.length > 80 ||
    (value.role !== 'user' &&
      value.role !== 'agent' &&
      value.role !== 'facilitator') ||
    typeof value.content !== 'string' ||
    value.content.length > 8_000 ||
    typeof value.createdAt !== 'string' ||
    value.createdAt.length > 60 ||
    (value.agentId !== undefined &&
      (typeof value.agentId !== 'string' || value.agentId.length > 80)) ||
    (value.agentName !== undefined &&
      (typeof value.agentName !== 'string' || value.agentName.length > 80)) ||
    (value.agentRole !== undefined &&
      (typeof value.agentRole !== 'string' || value.agentRole.length > 120)) ||
    (value.imageUrl !== undefined && !isBoardroomImageSource(value.imageUrl))
  ) {
    return null
  }
  if (
    value.role !== 'user' &&
    (typeof value.agentId !== 'string' || typeof value.agentName !== 'string')
  ) {
    return null
  }

  return {
    id: value.id,
    role: value.role,
    content: value.content,
    createdAt: value.createdAt,
    ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
    ...(typeof value.agentName === 'string' ? { agentName: value.agentName } : {}),
    ...(typeof value.agentRole === 'string' ? { agentRole: value.agentRole } : {}),
    ...(isBoardroomImageSource(value.imageUrl) ? { imageUrl: value.imageUrl } : {}),
  }
}

function readReport(value: unknown): BoardroomReport | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    value.id.length > 80 ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    value.title.length > 120 ||
    (value.type !== 'scope' &&
      value.type !== 'review' &&
      value.type !== 'custom') ||
    typeof value.content !== 'string' ||
    value.content.length > 40_000 ||
    typeof value.createdAt !== 'string' ||
    value.createdAt.length > 60
  ) {
    return null
  }

  return {
    id: value.id,
    title: value.title,
    type: value.type,
    content: value.content,
    createdAt: value.createdAt,
  }
}

function readMeeting(value: unknown): Meeting | null {
  const mode = value && isRecord(value)
    ? value.mode === undefined
      ? 'discussion'
      : value.mode
    : undefined
  const chatType = value && isRecord(value)
    ? value.chatType === undefined
      ? mode === 'chat'
        ? 'document'
        : 'informational'
      : value.chatType
    : undefined
  const chatMessagesValue =
    value && isRecord(value) && value.chatMessages === undefined
      ? []
      : value && isRecord(value)
        ? value.chatMessages
        : undefined
  const reportsValue =
    value && isRecord(value) && value.reports === undefined
      ? []
      : value && isRecord(value)
        ? value.reports
        : undefined
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.task !== 'string' ||
    !Array.isArray(value.agents) ||
    value.agents.length < 1 ||
    value.agents.length > 5 ||
    typeof value.facilitatorId !== 'string' ||
    (mode !== 'discussion' && mode !== 'chat') ||
    (chatType !== 'informational' && chatType !== 'document') ||
    typeof value.rounds !== 'number' ||
    !Number.isInteger(value.rounds) ||
    value.rounds < 1 ||
    value.rounds > 3 ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    (value.status !== 'ready' &&
      value.status !== 'running' &&
      value.status !== 'completed' &&
      value.status !== 'interrupted') ||
    !Array.isArray(value.transcript) ||
    !Array.isArray(chatMessagesValue) ||
    !Array.isArray(reportsValue) ||
    typeof value.synthesis !== 'string' ||
    typeof value.error !== 'string'
  ) {
    return null
  }

  const agents = value.agents.map(readAgent)
  const transcript = value.transcript.map(readTurn)
  const chatMessages = chatMessagesValue.map(readChatMessage)
  const reports = reportsValue.map(readReport)
  if (
    agents.some((agent) => agent === null) ||
    transcript.some((turn) => turn === null) ||
    chatMessages.some((message) => message === null) ||
    reports.some((report) => report === null) ||
    !agents.some((agent) => agent?.id === value.facilitatorId)
  ) {
    return null
  }
  const meetingAgents = agents.filter(
    (agent): agent is AgentConfig => agent !== null,
  )
  const agentRoles = normalizeChatAgentRoles(
    meetingAgents.map((agent) => agent.id),
    value.agentRoles,
  )
  if (!agentRoles) return null

  return {
    id: value.id,
    name: value.name,
    task: value.task,
    mode: mode as MeetingMode,
    chatType: chatType as ChatType,
    agents: meetingAgents,
    agentRoles,
    facilitatorId: value.facilitatorId,
    rounds: value.rounds,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    status: value.status as MeetingStatus,
    transcript: transcript.filter((turn): turn is BoardroomTurn => turn !== null),
    chatMessages: chatMessages.filter(
      (message): message is BoardroomChatMessage => message !== null,
    ),
    reports: reports.filter((report): report is BoardroomReport => report !== null),
    synthesis: value.synthesis,
    error: value.error,
  }
}

function readCollection<T>(
  value: unknown,
  label: string,
  readItem: (item: unknown) => T | null,
): T[] {
  if (!Array.isArray(value)) {
    throw new BoardroomStateInputError(`${label} must be an array.`)
  }

  const items = value.map(readItem)
  if (items.some((item) => item === null)) {
    throw new BoardroomStateInputError(`${label} contains an invalid entry.`)
  }
  return items.filter((item): item is T => item !== null)
}

function ensureUniqueIds<T extends { id: string }>(items: T[], label: string): T[] {
  const ids = new Set<string>()
  for (const item of items) {
    if (!item.id.trim() || ids.has(item.id)) {
      throw new BoardroomStateInputError(`${label} IDs must be non-empty and unique.`)
    }
    ids.add(item.id)
  }
  return items
}

export function parseBoardroomStatePatch(value: unknown): BoardroomStatePatch {
  if (!isRecord(value)) {
    throw new BoardroomStateInputError('Boardroom state must be an object.')
  }

  const patch: BoardroomStatePatch = {}
  if ('agents' in value) {
    patch.agents = ensureUniqueIds(
      readCollection(value.agents, 'Agents', readAgent),
      'Agent',
    )
  }
  if ('meetings' in value) {
    patch.meetings = ensureUniqueIds(
      readCollection(value.meetings, 'Meetings', readMeeting),
      'Meeting',
    )
  }
  if (patch.agents === undefined && patch.meetings === undefined) {
    throw new BoardroomStateInputError('Provide agents or meetings to save.')
  }
  return patch
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function parseStoredState(value: unknown): BoardroomState {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.revision !== 'number' ||
    !Number.isInteger(value.revision) ||
    value.revision < 0
  ) {
    throw new Error('Stored DiscussIt data has an unsupported or invalid format.')
  }
  const patch = parseBoardroomStatePatch(value)
  if (patch.agents === undefined || patch.meetings === undefined) {
    throw new Error('Stored DiscussIt data is incomplete.')
  }
  return {
    revision: value.revision,
    agents: patch.agents,
    meetings: patch.meetings,
  }
}

export async function readBoardroomState(
  filePath = stateFile,
): Promise<BoardroomState | null> {
  let contents: string
  try {
    contents = await readFile(filePath, 'utf8')
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
  return parseStoredState(JSON.parse(contents) as unknown)
}

async function writeBoardroomState(
  filePath: string,
  state: BoardroomState,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(
    temporaryPath,
    JSON.stringify({ version: 1, ...state }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  )
  await rename(temporaryPath, filePath)
}

const writeQueues = new Map<string, Promise<void>>()

function serializeWrite<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve()
  const current = previous.then(operation, operation)
  const queueTail = current.then(
    () => undefined,
    () => undefined,
  )
  writeQueues.set(filePath, queueTail)
  return current.finally(() => {
    if (writeQueues.get(filePath) === queueTail) writeQueues.delete(filePath)
  })
}

export function updateBoardroomState(
  patch: BoardroomStatePatch,
  filePath = stateFile,
): Promise<BoardroomState> {
  return serializeWrite(filePath, async () => {
    const current = await readBoardroomState(filePath)
    const next: BoardroomState = {
      revision: (current?.revision ?? 0) + 1,
      agents: patch.agents ?? current?.agents ?? [],
      meetings: patch.meetings ?? current?.meetings ?? [],
    }
    await writeBoardroomState(filePath, next)
    return next
  })
}

function mergeMissing<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const ids = new Set(current.map((item) => item.id))
  return [...current, ...incoming.filter((item) => !ids.has(item.id))]
}

function agentsMatch(first: AgentConfig, second: AgentConfig): boolean {
  return (
    first.name === second.name &&
    first.role === second.role &&
    first.defaultChatRole === second.defaultChatRole &&
    first.provider === second.provider &&
    first.model === second.model &&
    JSON.stringify(first.modelCapabilities ?? {}) ===
      JSON.stringify(second.modelCapabilities ?? {}) &&
    first.knowledge === second.knowledge &&
    first.skills === second.skills &&
    first.instructions === second.instructions
  )
}

function synchronizeMeetingAgentSnapshots(
  meetings: Meeting[],
  agents: AgentConfig[],
): { meetings: Meeting[]; changed: boolean } {
  const profiles = new Map(agents.map((agent) => [agent.id, agent]))
  let changed = false
  const synchronized = meetings.map((meeting) => {
    let meetingChanged = false
    const updatedAgents = meeting.agents.map((snapshot) => {
      const current = profiles.get(snapshot.id)
      if (!current || agentsMatch(snapshot, current)) return snapshot
      meetingChanged = true
      return current
    })
    if (!meetingChanged) return meeting
    changed = true
    return {
      ...meeting,
      agents: updatedAgents,
      updatedAt: new Date().toISOString(),
    }
  })
  return { meetings: synchronized, changed }
}

export function importBoardroomState(
  incoming: Required<BoardroomStatePatch>,
  filePath = stateFile,
): Promise<BoardroomState> {
  return serializeWrite(filePath, async () => {
    const current = await readBoardroomState(filePath)
    const agents = mergeMissing(current?.agents ?? [], incoming.agents)
    const mergedMeetings = mergeMissing(current?.meetings ?? [], incoming.meetings)
    const { meetings, changed: snapshotsChanged } =
      synchronizeMeetingAgentSnapshots(mergedMeetings, agents)
    if (
      current &&
      agents.length === current.agents.length &&
      meetings.length === current.meetings.length &&
      !snapshotsChanged
    ) {
      return current
    }

    const next: BoardroomState = {
      revision: (current?.revision ?? 0) + 1,
      agents,
      meetings,
    }
    await writeBoardroomState(filePath, next)
    return next
  })
}

export function recoverInterruptedMeetings(
  filePath = stateFile,
): Promise<BoardroomState | null> {
  return serializeWrite(filePath, async () => {
    const current = await readBoardroomState(filePath)
    if (!current) return null

    const snapshots = synchronizeMeetingAgentSnapshots(current.meetings, current.agents)
    let changed = snapshots.changed
    const meetings = snapshots.meetings.map((meeting) => {
      if (meeting.status !== 'running') return meeting
      changed = true
      return {
        ...meeting,
        status: 'interrupted' as const,
        error: 'The server restarted before this discussion completed.',
        updatedAt: new Date().toISOString(),
      }
    })
    if (!changed) return current

    const next = {
      ...current,
      revision: current.revision + 1,
      meetings,
    }
    await writeBoardroomState(filePath, next)
    return next
  })
}
