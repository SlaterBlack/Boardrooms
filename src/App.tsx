import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import {
  isBoardroomChatAttachment,
  MAX_BOARDROOM_CHAT_ATTACHMENTS,
  MAX_BOARDROOM_CHAT_MEMORY_LENGTH,
} from '../shared/boardroom'
import type {
  AgentConfig,
  BoardroomChatMessage,
  BoardroomReport,
  ChatType,
  Meeting,
  MeetingMode,
  MeetingStatus,
  Provider,
  ProviderAvailability,
} from '../shared/boardroom'
import AccountMenu, { type Theme } from './components/AccountMenu'
import AgentEditorModal from './components/AgentEditorModal'
import MeetingEditorModal, {
  type NewMeetingDetails,
} from './components/MeetingEditorModal'
import MeetingRoom from './components/MeetingRoom'
import { createId } from './createId'
import {
  isDecisionRoutingAgent,
  isBoardroomImageSource,
  isTextGenerationAgent,
  modelCapabilityLabels,
  normalizeChatAgentRoles,
  normalizeModelCapabilities,
} from '../shared/chat'
import discussItLogo from './assets/DiscussIt_64.png'
import './App.css'

const AGENT_STORAGE_KEY = 'boardrooms.agents'
const MEETING_STORAGE_KEY = 'boardrooms.meetings'
const LEGACY_AGENT_STORAGE_KEY = 'boardmeetings.agents'
const LEGACY_MEETING_STORAGE_KEY = 'boardmeetings.meetings'
const SERVER_IMPORT_STORAGE_KEY = 'boardrooms.serverImport.v1'

const DEFAULT_AGENTS: AgentConfig[] = [
  {
    id: 'strategy-advisor',
    name: 'Strategy advisor',
    role: 'Strategy & market perspective',
    provider: 'openai',
    model: 'gpt-6.2-sol',
    knowledge: 'Market strategy, product positioning, and long-term planning.',
    skills: 'Opportunity analysis, tradeoff assessment, and scenario planning.',
    instructions: 'Look for strategic opportunities and second-order effects.',
  },
  {
    id: 'risk-advisor',
    name: 'Risk advisor',
    role: 'Risk & governance',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    knowledge: 'Organizational risk, governance, and responsible decision-making.',
    skills: 'Risk identification, mitigation planning, and policy review.',
    instructions: 'Surface risks, ethical considerations, and governance implications.',
  },
]

type ProviderState = 'checking' | 'connected' | 'disconnected'
type AuthState = 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable'
type Tab = 'meetings' | 'agents'

const THEME_STORAGE_KEY = 'discussit_theme'

function readTheme(): Theme {
  const storedTheme = localStorage.getItem(THEME_STORAGE_KEY)
  if (storedTheme === 'default' || storedTheme === 'retro') return storedTheme
  if (storedTheme !== null) {
    console.error('Stored DiscussIt theme is unsupported; resetting to Blue & Cream.')
    localStorage.removeItem(THEME_STORAGE_KEY)
  }
  return 'default'
}

interface SharedBoardroomState {
  initialized: boolean
  revision: number
  agents: AgentConfig[]
  meetings: Meeting[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeAgent(value: unknown): AgentConfig | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.role !== 'string' ||
    (value.provider !== 'openai' &&
      value.provider !== 'anthropic' &&
      value.provider !== 'gemini' &&
      value.provider !== 'openrouter' &&
      value.provider !== 'magnific') ||
    typeof value.model !== 'string'
  ) {
    return null
  }

  const modelCapabilities = normalizeModelCapabilities(value.modelCapabilities)
  if (!modelCapabilities) return null
  const provider: Provider =
    value.provider === 'gemini'
      ? 'gemini'
      : value.provider === 'anthropic'
        ? 'anthropic'
        : value.provider === 'openrouter'
          ? 'openrouter'
          : value.provider === 'magnific'
            ? 'magnific'
            : 'openai'
  return {
    id: value.id,
    name: value.name,
    role: value.role,
    modelCapabilities,
    provider,
    model: value.model,
    knowledge: typeof value.knowledge === 'string' ? value.knowledge : '',
    skills: typeof value.skills === 'string' ? value.skills : '',
    instructions: typeof value.instructions === 'string' ? value.instructions : '',
  }
}

function normalizeMeeting(value: unknown, interruptRunning = true): Meeting | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.task !== 'string' ||
    !Array.isArray(value.agents) ||
    typeof value.facilitatorId !== 'string' ||
    typeof value.rounds !== 'number' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !['ready', 'running', 'completed', 'interrupted'].includes(String(value.status))
  ) {
    return null
  }

  const agents = value.agents.map(normalizeAgent)
  if (agents.some((agent) => agent === null)) return null

  const transcript = Array.isArray(value.transcript)
    ? value.transcript.filter(
        (turn): turn is Meeting['transcript'][number] =>
          isRecord(turn) &&
          typeof turn.id === 'string' &&
          typeof turn.agentId === 'string' &&
          typeof turn.agentName === 'string' &&
          typeof turn.agentRole === 'string' &&
          typeof turn.round === 'number' &&
          typeof turn.content === 'string',
      )
    : []
  const mode = value.mode === undefined ? 'discussion' : value.mode
  if (mode !== 'discussion' && mode !== 'chat') return null
  const chatType =
    value.chatType === undefined
      ? mode === 'chat'
        ? 'document'
        : 'informational'
      : value.chatType
  if (chatType !== 'informational' && chatType !== 'document') return null
  const rawChatMessages =
    value.chatMessages === undefined ? [] : value.chatMessages
  if (!Array.isArray(rawChatMessages)) return null
  const chatMessages = rawChatMessages.filter(
    (message): message is BoardroomChatMessage =>
      isRecord(message) &&
      typeof message.id === 'string' &&
      (message.role === 'user' ||
        message.role === 'agent' ||
        message.role === 'facilitator') &&
      typeof message.content === 'string' &&
      typeof message.createdAt === 'string' &&
      (message.agentId === undefined || typeof message.agentId === 'string') &&
      (message.agentName === undefined || typeof message.agentName === 'string') &&
      (message.agentRole === undefined || typeof message.agentRole === 'string') &&
      (message.imageUrl === undefined || isBoardroomImageSource(message.imageUrl)) &&
      (message.attachments === undefined ||
        (Array.isArray(message.attachments) &&
          message.attachments.length <= MAX_BOARDROOM_CHAT_ATTACHMENTS &&
          message.attachments.every(isBoardroomChatAttachment))) &&
      (message.role === 'user' ||
        (typeof message.agentId === 'string' &&
          typeof message.agentName === 'string')),
  )
  const chatMemory =
    value.chatMemory === undefined
      ? undefined
      : isRecord(value.chatMemory) &&
          typeof value.chatMemory.summary === 'string' &&
          value.chatMemory.summary.trim().length > 0 &&
          value.chatMemory.summary.length <= MAX_BOARDROOM_CHAT_MEMORY_LENGTH &&
          typeof value.chatMemory.throughMessageCount === 'number' &&
          Number.isSafeInteger(value.chatMemory.throughMessageCount) &&
          value.chatMemory.throughMessageCount >= 0 &&
          value.chatMemory.throughMessageCount <= chatMessages.length
        ? {
            summary: value.chatMemory.summary,
            throughMessageCount: value.chatMemory.throughMessageCount,
          }
        : null
  if (value.chatMemory !== undefined && !chatMemory) return null
  const rawReports = value.reports === undefined ? [] : value.reports
  if (!Array.isArray(rawReports)) return null
  const reports = rawReports.filter(
    (report): report is BoardroomReport =>
      isRecord(report) &&
      typeof report.id === 'string' &&
      typeof report.title === 'string' &&
      (report.type === 'scope' ||
        report.type === 'review' ||
        report.type === 'custom') &&
      typeof report.content === 'string' &&
      typeof report.createdAt === 'string',
  )
  const meetingAgents = agents.filter(
    (agent): agent is AgentConfig => agent !== null,
  )
  const preferredDirectorId =
    meetingAgents.length >= 2
      ? meetingAgents.find(
          (agent) =>
            (isTextGenerationAgent(agent) || isDecisionRoutingAgent(agent)) &&
            isRecord(value.agentRoles) &&
            value.agentRoles[agent.id] === 'director',
        )?.id ??
        meetingAgents.find(isTextGenerationAgent)?.id ??
        meetingAgents.find(isDecisionRoutingAgent)?.id
      : undefined
  const agentRoles = normalizeChatAgentRoles(
    meetingAgents.map((agent) => agent.id),
    value.agentRoles,
    preferredDirectorId,
  )
  if (!agentRoles) return null
  const wasRunning = interruptRunning && value.status === 'running'

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
    status: wasRunning ? 'interrupted' : (value.status as MeetingStatus),
    transcript,
    chatMessages,
    ...(chatMemory ? { chatMemory } : {}),
    reports,
    synthesis: typeof value.synthesis === 'string' ? value.synthesis : '',
    error: wasRunning
      ? 'This meeting was interrupted when the page closed.'
      : (typeof value.error === 'string' ? value.error : ''),
  }
}

function normalizeSharedBoardroomState(value: unknown): SharedBoardroomState {
  if (
    !isRecord(value) ||
    typeof value.initialized !== 'boolean' ||
    typeof value.revision !== 'number' ||
    !Number.isInteger(value.revision) ||
    !Array.isArray(value.agents) ||
    !Array.isArray(value.meetings)
  ) {
    throw new Error('The shared DiscussIt data response was invalid.')
  }

  const agents = value.agents.map(normalizeAgent)
  const meetings = value.meetings.map((meeting) => normalizeMeeting(meeting, false))
  if (agents.some((agent) => agent === null) || meetings.some((meeting) => meeting === null)) {
    throw new Error('The shared DiscussIt data contains an invalid entry.')
  }

  return {
    initialized: value.initialized,
    revision: value.revision,
    agents: agents.filter((agent): agent is AgentConfig => agent !== null),
    meetings: meetings.filter((meeting): meeting is Meeting => meeting !== null),
  }
}

function loadAgents(): AgentConfig[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(AGENT_STORAGE_KEY) ??
        localStorage.getItem(LEGACY_AGENT_STORAGE_KEY) ??
        'null',
    )
    if (Array.isArray(stored)) {
      const agents = stored.map(normalizeAgent)
      if (agents.every((agent) => agent !== null)) {
        return agents.filter((agent): agent is AgentConfig => agent !== null)
      }
    }
  } catch {
    return DEFAULT_AGENTS
  }
  return DEFAULT_AGENTS
}

function loadMeetings(): Meeting[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(MEETING_STORAGE_KEY) ??
        localStorage.getItem(LEGACY_MEETING_STORAGE_KEY) ??
        'null',
    )
    if (Array.isArray(stored)) {
      return stored
        .map((meeting) => normalizeMeeting(meeting))
        .filter((meeting): meeting is Meeting => meeting !== null)
    }
  } catch {
    return []
  }
  return []
}

async function fetchSharedBoardroomState(
  revision?: number,
  signal?: AbortSignal,
): Promise<SharedBoardroomState | null> {
  const query = revision === undefined ? '' : `?since=${revision}`
  const response = await fetch(`/api/state${query}`, { cache: 'no-store', signal })
  if (response.status === 204) return null
  if (!response.ok) {
    throw new Error(`Shared DiscussIt data returned ${response.status}.`)
  }
  return normalizeSharedBoardroomState(await response.json())
}

async function loadSharedBoardroomState(signal?: AbortSignal): Promise<SharedBoardroomState> {
  let state = await fetchSharedBoardroomState(undefined, signal)
  if (!state) throw new Error('The server did not return shared DiscussIt data.')

  const migrationComplete = localStorage.getItem(SERVER_IMPORT_STORAGE_KEY) === 'true'
  const hasLocalBoardroomData = [
    AGENT_STORAGE_KEY,
    MEETING_STORAGE_KEY,
    LEGACY_AGENT_STORAGE_KEY,
    LEGACY_MEETING_STORAGE_KEY,
  ].some((key) => localStorage.getItem(key) !== null)
  const needsImport = !state.initialized || (!migrationComplete && hasLocalBoardroomData)
  if (needsImport) {
    const response = await fetch('/api/state/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents: loadAgents(), meetings: loadMeetings() }),
      signal,
    })
    if (!response.ok) {
      throw new Error(`Could not import this browser's boardroom data (${response.status}).`)
    }
    state = normalizeSharedBoardroomState(await response.json())
  }
  if (!migrationComplete) {
    localStorage.setItem(SERVER_IMPORT_STORAGE_KEY, 'true')
  }
  return state
}

async function readProviderAvailability(signal?: AbortSignal): Promise<ProviderAvailability> {
  const response = await fetch('/api/providers', { signal })
  if (!response.ok) throw new Error(`Provider status returned ${response.status}`)

  const result: unknown = await response.json()
  if (
    !isRecord(result) ||
    !isRecord(result.providers) ||
    typeof result.providers.openai !== 'boolean' ||
    typeof result.providers.anthropic !== 'boolean' ||
    typeof result.providers.gemini !== 'boolean' ||
    typeof result.providers.openrouter !== 'boolean' ||
    typeof result.providers.magnific !== 'boolean'
  ) {
    throw new Error('Provider status response was invalid.')
  }
  return {
    openai: result.providers.openai,
    anthropic: result.providers.anthropic,
    gemini: result.providers.gemini,
    openrouter: result.providers.openrouter,
    magnific: result.providers.magnific,
  }
}

function providerLabel(provider: Provider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI'
    case 'anthropic':
      return 'Anthropic'
    case 'gemini':
      return 'Gemini'
    case 'openrouter':
      return 'OpenRouter'
    case 'magnific':
      return 'Magnific'
  }
}

function meetingStatusLabel(status: MeetingStatus): string {
  switch (status) {
    case 'ready':
      return 'Ready'
    case 'running':
      return 'In discussion'
    case 'completed':
      return 'Completed'
    case 'interrupted':
      return 'Interrupted'
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function App() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [authState, setAuthState] = useState<AuthState>('checking')
  const [loginPassword, setLoginPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [logoutError, setLogoutError] = useState('')
  const [activeTab, setActiveTab] = useState<Tab>('meetings')
  const [agents, setAgents] = useState<AgentConfig[]>(loadAgents)
  const [meetings, setMeetings] = useState<Meeting[]>(loadMeetings)
  const agentsRef = useRef(agents)
  const meetingsRef = useRef(meetings)
  const stateRevisionRef = useRef(0)
  const stateSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingStateSavesRef = useRef(0)
  const unsavedStateRef = useRef(false)
  const [activeMeetingId, setActiveMeetingId] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderAvailability | null>(null)
  const [providerState, setProviderState] = useState<ProviderState>('checking')
  const [connectionError, setConnectionError] = useState('')
  const [storageError, setStorageError] = useState('')
  const [showAgentModal, setShowAgentModal] = useState(false)
  const [editingAgent, setEditingAgent] = useState<AgentConfig | null>(null)
  const [showMeetingModal, setShowMeetingModal] = useState(false)
  const [editingMeeting, setEditingMeeting] = useState<Meeting | null>(null)

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_STORAGE_KEY, theme)
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'retro' ? '#081b2c' : '#f7f1e6')
  }, [theme])

  function applySharedState(state: SharedBoardroomState) {
    stateRevisionRef.current = state.revision
    agentsRef.current = state.agents
    meetingsRef.current = state.meetings
    setAgents(state.agents)
    setMeetings(state.meetings)
  }

  useEffect(() => {
    const controller = new AbortController()

    async function checkSession() {
      try {
        const response = await fetch('/api/auth/session', { signal: controller.signal })
        if (response.status === 401) {
          setAuthState('unauthenticated')
          return
        }
        if (!response.ok) throw new Error(`Sign-in status returned ${response.status}`)

        const [availability, sharedState] = await Promise.all([
          readProviderAvailability(controller.signal),
          loadSharedBoardroomState(controller.signal),
        ])
        applySharedState(sharedState)
        setProviders(availability)
        setProviderState('connected')
        setAuthState('authenticated')
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return
        setAuthState('unavailable')
        setProviderState('disconnected')
        setConnectionError(
          requestError instanceof Error ? requestError.message : 'Could not reach the server.',
        )
      }
    }

    void checkSession()
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (authState !== 'authenticated') return

    const controller = new AbortController()
    let syncing = false

    async function syncSharedState() {
      if (
        syncing ||
        pendingStateSavesRef.current > 0 ||
        unsavedStateRef.current
      ) {
        return
      }

      syncing = true
      try {
        const state = await fetchSharedBoardroomState(
          stateRevisionRef.current,
          controller.signal,
        )
        if (state && state.revision > stateRevisionRef.current) {
          applySharedState(state)
        }
        setStorageError('')
      } catch (requestError) {
        if (controller.signal.aborted) return
        setStorageError(
          requestError instanceof Error
            ? requestError.message
            : 'Could not sync shared DiscussIt data.',
        )
      } finally {
        syncing = false
      }
    }

    const interval = window.setInterval(() => void syncSharedState(), 3_000)
    window.addEventListener('focus', syncSharedState)
    return () => {
      controller.abort()
      window.clearInterval(interval)
      window.removeEventListener('focus', syncSharedState)
    }
  }, [authState])

  function saveSharedState(patch: { agents?: AgentConfig[]; meetings?: Meeting[] }) {
    pendingStateSavesRef.current += 1
    unsavedStateRef.current = true

    const request = stateSaveQueueRef.current
      .then(async () => {
        const response = await fetch('/api/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
        const result: unknown = await response.json()
        if (!response.ok) {
          throw new Error(
            isRecord(result) && typeof result.error === 'string'
              ? result.error
              : `Saving shared DiscussIt data returned ${response.status}.`,
          )
        }

        const state = normalizeSharedBoardroomState(result)
        if (pendingStateSavesRef.current === 1) {
          applySharedState(state)
          unsavedStateRef.current = false
          setStorageError('')
        }
      })
      .catch((requestError: unknown) => {
        unsavedStateRef.current = true
        setStorageError(
          requestError instanceof Error
            ? requestError.message
            : 'Could not save shared DiscussIt data.',
        )
      })
      .finally(() => {
        pendingStateSavesRef.current -= 1
      })

    stateSaveQueueRef.current = request
  }

  function persistAgents(updated: AgentConfig[]) {
    agentsRef.current = updated
    setAgents(updated)
    saveSharedState({ agents: updated })
  }

  function persistMeetings(updated: Meeting[]) {
    meetingsRef.current = updated
    setMeetings(updated)
    saveSharedState({ meetings: updated })
  }

  function persistAgentsAndMeetings(
    updatedAgents: AgentConfig[],
    updatedMeetings: Meeting[],
  ) {
    agentsRef.current = updatedAgents
    meetingsRef.current = updatedMeetings
    setAgents(updatedAgents)
    setMeetings(updatedMeetings)
    saveSharedState({ agents: updatedAgents, meetings: updatedMeetings })
  }

  function saveAgent(agent: AgentConfig) {
    const exists = agents.some((current) => current.id === agent.id)
    const updated = exists
      ? agents.map((current) => (current.id === agent.id ? agent : current))
      : [...agents, agent]
    let updatedMeetings = false
    const syncedMeetings = meetingsRef.current.map((meeting) => {
      if (!meeting.agents.some((meetingAgent) => meetingAgent.id === agent.id)) {
        return meeting
      }

      updatedMeetings = true
      return {
        ...meeting,
        agents: meeting.agents.map((meetingAgent) =>
          meetingAgent.id === agent.id ? agent : meetingAgent,
        ),
        updatedAt: new Date().toISOString(),
      }
    })
    if (updatedMeetings) {
      persistAgentsAndMeetings(updated, syncedMeetings)
    } else {
      persistAgents(updated)
    }
    setShowAgentModal(false)
    setEditingAgent(null)
  }

  function deleteAgent(agentId: string) {
    const agent = agents.find((current) => current.id === agentId)
    if (!agent || !window.confirm(`Delete ${agent.name}? Existing boardrooms keep their saved copy.`)) {
      return
    }
    persistAgents(agents.filter((current) => current.id !== agentId))
    setShowAgentModal(false)
    setEditingAgent(null)
  }

  function createMeeting(details: NewMeetingDetails) {
    const now = new Date().toISOString()
    const meeting: Meeting = {
      id: createId(),
      ...details,
      mode: 'chat',
      task: details.task.trim() || 'Ongoing boardroom chat',
      agents: details.agents.map((agent) => ({ ...agent })),
      rounds: 1,
      createdAt: now,
      updatedAt: now,
      status: 'ready',
      transcript: [],
      chatMessages: [],
      reports: [],
      synthesis: '',
      error: '',
    }
    persistMeetings([meeting, ...meetingsRef.current])
    setShowMeetingModal(false)
    setActiveMeetingId(meeting.id)
  }

  function updateMeeting(updatedMeeting: Meeting) {
    persistMeetings(
      meetingsRef.current.map((meeting) =>
        meeting.id === updatedMeeting.id ? updatedMeeting : meeting,
      ),
    )
  }

  function saveMeeting(details: NewMeetingDetails) {
    if (!editingMeeting) {
      createMeeting(details)
      return
    }

    const currentMeeting =
      meetingsRef.current.find((meeting) => meeting.id === editingMeeting.id) ??
      editingMeeting
    updateMeeting({
      ...currentMeeting,
      ...details,
      updatedAt: new Date().toISOString(),
    })
    setEditingMeeting(null)
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAuthError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword }),
      })
      const result: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(
          isRecord(result) && typeof result.error === 'string'
            ? result.error
            : 'Could not sign in.',
        )
      }

      setLoginPassword('')
      const [availability, sharedState] = await Promise.all([
        readProviderAvailability(),
        loadSharedBoardroomState(),
      ])
      applySharedState(sharedState)
      setProviders(availability)
      setProviderState('connected')
      setConnectionError('')
      setAuthState('authenticated')
    } catch (requestError) {
      setAuthError(
        requestError instanceof Error ? requestError.message : 'Could not sign in.',
      )
    }
  }

  async function signOut() {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' })
      if (!response.ok) throw new Error(`Sign-out failed (${response.status}).`)
      setProviders(null)
      setAuthState('unauthenticated')
      setLogoutError('')
    } catch (requestError) {
      setLogoutError(
        requestError instanceof Error ? requestError.message : 'Could not sign out.',
      )
    }
  }

  const activeMeeting = meetings.find((meeting) => meeting.id === activeMeetingId)
  const isChatPage = activeTab === 'meetings' && activeMeeting?.mode === 'chat'
  const activeMeetings = meetings.filter(
    (meeting) => meeting.mode === 'chat' || meeting.status !== 'completed',
  )
  const completedMeetings = meetings.filter(
    (meeting) => meeting.mode !== 'chat' && meeting.status === 'completed',
  )

  if (authState !== 'authenticated') {
    return (
      <div className="auth-page">
        <header className="topbar">
          <a className="brand" href="/" aria-label="DiscussIt home">
            <img className="brand-logo" src={discussItLogo} alt="" />
            <span>DiscussIt</span>
          </a>
          <AccountMenu theme={theme} onThemeChange={setTheme} />
        </header>
        <main className="auth-shell">
          <section className="auth-card">
            <p className="eyebrow">PRIVATE BOARDROOM</p>
            <h1>
              {authState === 'checking' && 'Connecting to the boardroom…'}
              {authState === 'unauthenticated' && 'Sign in to your boardroom'}
              {authState === 'unavailable' && 'DiscussIt unavailable'}
            </h1>
            {authState === 'checking' && <p className="auth-copy">Checking your access…</p>}
            {authState === 'unavailable' && (
              <p className="auth-copy" role="alert">
                {connectionError || 'The DiscussIt server could not be reached.'}
              </p>
            )}
            {authState === 'unauthenticated' && (
              <>
                <p className="auth-copy">
                  Enter the shared access password configured by the DiscussIt host.
                </p>
                <form className="login-form" onSubmit={signIn}>
                  <label htmlFor="access-password">Access password</label>
                  <input
                    autoComplete="current-password"
                    id="access-password"
                    onChange={(change) => setLoginPassword(change.target.value)}
                    required
                    type="password"
                    value={loginPassword}
                  />
                  {authError && <p className="login-error" role="alert">{authError}</p>}
                  <button className="primary-button" type="submit">Enter boardroom</button>
                </form>
                <p className="auth-footnote">
                  Use only on a trusted local network. For untrusted networks, configure HTTPS.
                </p>
              </>
            )}
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className={`app-shell${isChatPage ? ' chat-app-shell' : ''}`}>
      <header className="topbar">
        <a className="brand" href="/" aria-label="DiscussIt home">
          <img className="brand-logo" src={discussItLogo} alt="" />
          <span>DiscussIt</span>
        </a>
        <nav aria-label="Workspace sections" className="tab-navigation" role="tablist">
          <button
            aria-selected={activeTab === 'meetings'}
            className={`tab-button ${activeTab === 'meetings' ? 'active' : ''}`}
            onClick={() => setActiveTab('meetings')}
            role="tab"
            type="button"
          >
            Chats <span className="tab-count">{activeMeetings.length}</span>
          </button>
          <button
            aria-selected={activeTab === 'agents'}
            className={`tab-button ${activeTab === 'agents' ? 'active' : ''}`}
            onClick={() => setActiveTab('agents')}
            role="tab"
            type="button"
          >
            Agents <span className="tab-count">{agents.length}</span>
          </button>
        </nav>
        <div className="topbar-actions">
          <div className={`service-status ${providerState}`}>
            <span className="status-dot" />
            {providerState === 'checking' && 'Connecting'}
            {providerState === 'connected' && 'DiscussIt ready'}
            {providerState === 'disconnected' && 'Server unavailable'}
          </div>
          {logoutError && <span className="logout-error" role="alert">{logoutError}</span>}
          <AccountMenu
            onSignOut={() => void signOut()}
            onThemeChange={setTheme}
            theme={theme}
          />
        </div>
      </header>

      <main className={`page-content${isChatPage ? ' chat-page-content' : ''}`}>
        {storageError && <p className="storage-notice" role="alert">{storageError}</p>}
        {connectionError && (
          <div className="notice error-notice" role="alert">
            <strong>Couldn’t connect to the DiscussIt server.</strong>
            <span>{connectionError}</span>
          </div>
        )}

        {activeTab === 'meetings' && (
          <section
            aria-labelledby="meetings-title"
            className={isChatPage ? 'chat-page-panel' : undefined}
            role="tabpanel"
          >
            <div className="page-heading">
              <div>
                <p className="eyebrow">YOUR AI MEETING HUB</p>
                <h1 id="meetings-title">Chats</h1>
                <p className="page-description">
                  Create an ongoing chat with your advisors. Choose informational or report/document mode.
                </p>
              </div>
              <button
                className="primary-button create-button"
                onClick={() => setShowMeetingModal(true)}
                type="button"
              >
                <span aria-hidden="true">+</span> Create boardroom
              </button>
            </div>

            {providerState === 'connected' &&
              providers &&
              !providers.openai &&
              !providers.anthropic &&
              !providers.gemini &&
              !providers.openrouter && (
              <div className="notice setup-notice">
                <strong>Connect an AI provider to start a chat.</strong>
                <span>
                  Add an <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>,
                  <code> GEMINI_API_KEY</code>, or <code>OPENROUTER_API_KEY</code> to the
                  server’s <code>.env</code> file, then restart DiscussIt.
                </span>
              </div>
            )}

            {activeMeeting ? (
              <MeetingRoom
                key={activeMeeting.id}
                meeting={activeMeeting}
                onBack={() => setActiveMeetingId(null)}
                onEdit={() => setEditingMeeting(activeMeeting)}
                onUpdate={updateMeeting}
                providers={providers}
              />
            ) : (
              <>
                <MeetingSection
                  meetings={activeMeetings}
                  title="Ongoing boardrooms"
                  onOpen={setActiveMeetingId}
                />
                <MeetingSection
                  meetings={completedMeetings}
                  title="Completed legacy meetings"
                  onOpen={setActiveMeetingId}
                />
                {meetings.length === 0 && (
                  <div className="empty-state">
                    <span className="empty-state-icon" aria-hidden="true">✳</span>
                    <h2>Your chats start here</h2>
                    <p>Create a chat, choose its type, then select which advisors should join.</p>
                    <button
                      className="primary-button"
                      onClick={() => setShowMeetingModal(true)}
                      type="button"
                    >
                      Create your first boardroom
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {activeTab === 'agents' && (
          <section aria-labelledby="agents-title" role="tabpanel">
            <div className="page-heading">
              <div>
                <p className="eyebrow">YOUR ADVISORY ROSTER</p>
                <h1 id="agents-title">Agents</h1>
                <p className="page-description">
                  Shape each agent’s expertise, skills, provider, and working style.
                </p>
              </div>
              <button
                className="primary-button create-button"
                onClick={() => {
                  setEditingAgent(null)
                  setShowAgentModal(true)
                }}
                type="button"
              >
                <span aria-hidden="true">+</span> Add agent
              </button>
            </div>

            {agents.length === 0 ? (
              <div className="empty-state">
                <span className="empty-state-icon" aria-hidden="true">✳</span>
                <h2>No agents yet</h2>
                <p>Create an agent profile with a name, point of view, and skills.</p>
                <button
                  className="primary-button"
                  onClick={() => setShowAgentModal(true)}
                  type="button"
                >
                  Add your first agent
                </button>
              </div>
            ) : (
              <div className="agent-grid">
                {agents.map((agent, index) => (
                  <AgentCard
                    agent={agent}
                    index={index}
                    key={agent.id}
                    onEdit={() => {
                      setEditingAgent(agent)
                      setShowAgentModal(true)
                    }}
                    onDelete={() => deleteAgent(agent.id)}
                  />
                ))}
              </div>
            )}
            <p className="agent-library-note">
              Saving agent edits updates their settings in existing boardrooms.
            </p>
          </section>
        )}
      </main>

      <footer className="page-footer">
        <span>Thoughtful perspectives, brought together.</span>
        <span>Agent profiles and chats sync across DiscussIt tabs and devices.</span>
      </footer>

      {showAgentModal && (
        <AgentEditorModal
          agent={editingAgent}
          key={editingAgent?.id ?? 'new-agent'}
          onClose={() => {
            setShowAgentModal(false)
            setEditingAgent(null)
          }}
          onDelete={deleteAgent}
          onSave={saveAgent}
        />
      )}
      {(showMeetingModal || editingMeeting) && (
        <MeetingEditorModal
          agents={agents}
          key={editingMeeting?.id ?? 'new-meeting'}
          meeting={editingMeeting ?? undefined}
          onClose={() => {
            setShowMeetingModal(false)
            setEditingMeeting(null)
          }}
          onSave={saveMeeting}
        />
      )}
    </div>
  )
}

interface MeetingSectionProps {
  meetings: Meeting[]
  title: string
  onOpen: (meetingId: string) => void
}

function MeetingSection({ meetings, title, onOpen }: MeetingSectionProps) {
  if (meetings.length === 0) return null

  return (
    <section className="meeting-section">
      <div className="section-heading">
        <h2>{title}</h2>
        <span>{meetings.length}</span>
      </div>
      <div className="meeting-grid">
        {meetings.map((meeting) => (
          <button
            className="meeting-card"
            key={meeting.id}
            onClick={() => onOpen(meeting.id)}
            type="button"
          >
            <div className="meeting-card-top">
              <span className={`meeting-status status-${meeting.status}`}>
                {meeting.mode === 'chat'
                  ? meeting.status === 'running'
                    ? 'Responding'
                    : 'Chat open'
                  : meetingStatusLabel(meeting.status)}
              </span>
              {meeting.mode === 'chat' && (
                <span className="meeting-mode-badge">
                  {meeting.chatType === 'document' ? 'REPORT CHAT' : 'INFO CHAT'}
                </span>
              )}
              <span className="meeting-date">{formatDate(meeting.updatedAt)}</span>
            </div>
            <h3>{meeting.name}</h3>
            <p className="meeting-card-task">{meeting.task}</p>
            <div className="meeting-card-footer">
              <span className="meeting-agent-stack">
                {meeting.agents.slice(0, 4).map((agent) => (
                  <span className="stack-avatar" key={agent.id} title={agent.name}>
                    {agent.name.trim().charAt(0).toUpperCase() || 'A'}
                  </span>
                ))}
              </span>
              <span className="meeting-card-count">
                {meeting.agents.length} {meeting.agents.length === 1 ? 'agent' : 'agents'}
              </span>
              <span className="meeting-card-arrow" aria-hidden="true">↗</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}

interface AgentCardProps {
  agent: AgentConfig
  index: number
  onEdit: () => void
  onDelete: () => void
}

function AgentCard({ agent, index, onEdit, onDelete }: AgentCardProps) {
  return (
    <article className="agent-profile-card">
      <div className="agent-profile-heading">
        <span className="profile-avatar">{agent.name.trim().charAt(0).toUpperCase() || 'A'}</span>
        <div className="profile-identity">
          <span className="profile-index">AGENT 0{index + 1}</span>
          <h2>{agent.name}</h2>
          <p>{agent.role}</p>
          <div aria-label="Model capabilities" className="model-capability-list">
            {modelCapabilityLabels(agent.modelCapabilities).length > 0
              ? modelCapabilityLabels(agent.modelCapabilities).map((capability) => (
                  <span key={capability}>{capability}</span>
                ))
              : <span>Text only</span>}
          </div>
        </div>
        <button className="secondary-button" onClick={onEdit} type="button">Edit</button>
      </div>
      <div className="agent-model-line">
        <span className={`provider-badge provider-${agent.provider}`}>
        {providerLabel(agent.provider)}
        </span>
        <code>{agent.model}</code>
      </div>
      <div className="agent-profile-detail">
        <h3>Knowledge</h3>
        <p>{agent.knowledge || 'No knowledge notes added yet.'}</p>
      </div>
      <div className="agent-profile-detail">
        <h3>Skills</h3>
        <p>{agent.skills || 'No skills added yet.'}</p>
      </div>
      <div className="agent-profile-bottom">
        <span>Instructions {agent.instructions ? 'added' : 'not set'}</span>
        <button className="text-button delete-button" onClick={onDelete} type="button">
          Delete agent
        </button>
      </div>
    </article>
  )
}

export default App
