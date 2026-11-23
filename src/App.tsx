import { useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  AgentConfig,
  Meeting,
  MeetingStatus,
  Provider,
  ProviderAvailability,
} from '../shared/boardroom'
import AgentEditorModal from './components/AgentEditorModal'
import MeetingEditorModal, {
  type NewMeetingDetails,
} from './components/MeetingEditorModal'
import MeetingRoom from './components/MeetingRoom'
import './App.css'

const AGENT_STORAGE_KEY = 'boardrooms.agents'
const MEETING_STORAGE_KEY = 'boardrooms.meetings'
const LEGACY_AGENT_STORAGE_KEY = 'boardmeetings.agents'
const LEGACY_MEETING_STORAGE_KEY = 'boardmeetings.meetings'

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
      value.provider !== 'openrouter') ||
    typeof value.model !== 'string'
  ) {
    return null
  }

  const provider: Provider =
    value.provider === 'anthropic'
      ? 'anthropic'
      : value.provider === 'openrouter'
        ? 'openrouter'
        : 'openai'
  return {
    id: value.id,
    name: value.name,
    role: value.role,
    provider,
    model: value.model,
    knowledge: typeof value.knowledge === 'string' ? value.knowledge : '',
    skills: typeof value.skills === 'string' ? value.skills : '',
    instructions: typeof value.instructions === 'string' ? value.instructions : '',
  }
}

function normalizeMeeting(value: unknown): Meeting | null {
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
  const wasRunning = value.status === 'running'

  return {
    id: value.id,
    name: value.name,
    task: value.task,
    agents: agents.filter((agent): agent is AgentConfig => agent !== null),
    facilitatorId: value.facilitatorId,
    rounds: value.rounds,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    status: wasRunning ? 'interrupted' : (value.status as MeetingStatus),
    transcript,
    synthesis: typeof value.synthesis === 'string' ? value.synthesis : '',
    error: wasRunning
      ? 'This meeting was interrupted when the page closed.'
      : (typeof value.error === 'string' ? value.error : ''),
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
        .map(normalizeMeeting)
        .filter((meeting): meeting is Meeting => meeting !== null)
    }
  } catch {
    return []
  }
  return []
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
    typeof result.providers.openrouter !== 'boolean'
  ) {
    throw new Error('Provider status response was invalid.')
  }
  return {
    openai: result.providers.openai,
    anthropic: result.providers.anthropic,
    openrouter: result.providers.openrouter,
  }
}

function providerLabel(provider: Provider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI'
    case 'anthropic':
      return 'Anthropic'
    case 'openrouter':
      return 'OpenRouter'
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
  const [authState, setAuthState] = useState<AuthState>('checking')
  const [loginPassword, setLoginPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [logoutError, setLogoutError] = useState('')
  const [activeTab, setActiveTab] = useState<Tab>('meetings')
  const [agents, setAgents] = useState<AgentConfig[]>(loadAgents)
  const [meetings, setMeetings] = useState<Meeting[]>(loadMeetings)
  const meetingsRef = useRef(meetings)
  const [activeMeetingId, setActiveMeetingId] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderAvailability | null>(null)
  const [providerState, setProviderState] = useState<ProviderState>('checking')
  const [connectionError, setConnectionError] = useState('')
  const [storageError, setStorageError] = useState('')
  const [showAgentModal, setShowAgentModal] = useState(false)
  const [editingAgent, setEditingAgent] = useState<AgentConfig | null>(null)
  const [showMeetingModal, setShowMeetingModal] = useState(false)

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

        setAuthState('authenticated')
        setProviders(await readProviderAvailability(controller.signal))
        setProviderState('connected')
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

  function persistAgents(updated: AgentConfig[]) {
    setAgents(updated)
    try {
      localStorage.setItem(AGENT_STORAGE_KEY, JSON.stringify(updated))
      setStorageError('')
    } catch {
      setStorageError('Agent settings could not be saved in this browser.')
    }
  }

  function persistMeetings(updated: Meeting[]) {
    meetingsRef.current = updated
    setMeetings(updated)
    try {
      localStorage.setItem(MEETING_STORAGE_KEY, JSON.stringify(updated))
      setStorageError('')
    } catch {
      setStorageError('Meeting details could not be saved in this browser.')
    }
  }

  function saveAgent(agent: AgentConfig) {
    const exists = agents.some((current) => current.id === agent.id)
    const updated = exists
      ? agents.map((current) => (current.id === agent.id ? agent : current))
      : [...agents, agent]
    persistAgents(updated)
    setShowAgentModal(false)
    setEditingAgent(null)
  }

  function deleteAgent(agentId: string) {
    const agent = agents.find((current) => current.id === agentId)
    if (!agent || !window.confirm(`Delete ${agent.name}? Existing meetings keep their saved copy.`)) {
      return
    }
    persistAgents(agents.filter((current) => current.id !== agentId))
    setShowAgentModal(false)
    setEditingAgent(null)
  }

  function createMeeting(details: NewMeetingDetails) {
    const now = new Date().toISOString()
    const meeting: Meeting = {
      id: crypto.randomUUID(),
      ...details,
      agents: details.agents.map((agent) => ({ ...agent })),
      createdAt: now,
      updatedAt: now,
      status: 'ready',
      transcript: [],
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
      setAuthState('authenticated')
      setProviders(await readProviderAvailability())
      setProviderState('connected')
      setConnectionError('')
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
  const activeMeetings = meetings.filter((meeting) => meeting.status !== 'completed')
  const completedMeetings = meetings.filter((meeting) => meeting.status === 'completed')

  if (authState !== 'authenticated') {
    return (
      <main className="auth-shell">
        <a className="brand" href="/" aria-label="Boardrooms home">
          <span className="brand-mark" aria-hidden="true">B</span>
          <span>boardrooms</span>
        </a>
        <section className="auth-card">
          <p className="eyebrow">PRIVATE BOARDROOM</p>
          <h1>
            {authState === 'checking' && 'Connecting to the boardroom…'}
            {authState === 'unauthenticated' && 'Sign in to your boardroom'}
            {authState === 'unavailable' && 'Boardroom unavailable'}
          </h1>
          {authState === 'checking' && <p className="auth-copy">Checking your access…</p>}
          {authState === 'unavailable' && (
            <p className="auth-copy" role="alert">
              {connectionError || 'The Boardrooms server could not be reached.'}
            </p>
          )}
          {authState === 'unauthenticated' && (
            <>
              <p className="auth-copy">
                Enter the shared access password configured by the Boardrooms host.
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
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Boardrooms home">
          <span className="brand-mark" aria-hidden="true">B</span>
          <span>boardrooms</span>
        </a>
        <div className="topbar-actions">
          <div className={`service-status ${providerState}`}>
            <span className="status-dot" />
            {providerState === 'checking' && 'Connecting'}
            {providerState === 'connected' && 'Boardroom ready'}
            {providerState === 'disconnected' && 'Server unavailable'}
          </div>
          {logoutError && <span className="logout-error" role="alert">{logoutError}</span>}
          <button className="sign-out-button" onClick={() => void signOut()} type="button">
            Sign out
          </button>
        </div>
      </header>

      <nav aria-label="Workspace sections" className="tab-navigation" role="tablist">
        <button
          aria-selected={activeTab === 'meetings'}
          className={`tab-button ${activeTab === 'meetings' ? 'active' : ''}`}
          onClick={() => setActiveTab('meetings')}
          role="tab"
          type="button"
        >
          Meetings <span className="tab-count">{activeMeetings.length}</span>
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

      <main className="page-content">
        {storageError && <p className="storage-notice" role="alert">{storageError}</p>}
        {connectionError && (
          <div className="notice error-notice" role="alert">
            <strong>Couldn’t connect to the Boardrooms server.</strong>
            <span>{connectionError}</span>
          </div>
        )}

        {activeTab === 'meetings' && (
          <section aria-labelledby="meetings-title" role="tabpanel">
            <div className="page-heading">
              <div>
                <p className="eyebrow">YOUR AI MEETING HUB</p>
                <h1 id="meetings-title">Meetings</h1>
                <p className="page-description">
                  Bring your agents together around a task and keep each discussion in one place.
                </p>
              </div>
              <button
                className="primary-button create-button"
                onClick={() => setShowMeetingModal(true)}
                type="button"
              >
                <span aria-hidden="true">+</span> Create meeting
              </button>
            </div>

            {providerState === 'connected' &&
              providers &&
              !providers.openai &&
              !providers.anthropic &&
              !providers.openrouter && (
              <div className="notice setup-notice">
                <strong>Connect an AI provider to start a discussion.</strong>
                <span>
                  Add an <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, or
                  <code> OPENROUTER_API_KEY</code> to the server’s <code>.env</code> file,
                  then restart Boardrooms.
                </span>
              </div>
            )}

            {activeMeeting ? (
              <MeetingRoom
                key={activeMeeting.id}
                meeting={activeMeeting}
                onBack={() => setActiveMeetingId(null)}
                onUpdate={updateMeeting}
                providers={providers}
              />
            ) : (
              <>
                <MeetingSection
                  meetings={activeMeetings}
                  title="Active meetings"
                  onOpen={setActiveMeetingId}
                />
                <MeetingSection
                  meetings={completedMeetings}
                  title="Completed meetings"
                  onOpen={setActiveMeetingId}
                />
                {meetings.length === 0 && (
                  <div className="empty-state">
                    <span className="empty-state-icon" aria-hidden="true">✳</span>
                    <h2>Your boardroom starts here</h2>
                    <p>Create a meeting, add an agenda, and choose which agents should join.</p>
                    <button
                      className="primary-button"
                      onClick={() => setShowMeetingModal(true)}
                      type="button"
                    >
                      Create your first meeting
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
              Meeting participants keep a snapshot of their agent settings. Changes apply to new meetings.
            </p>
          </section>
        )}
      </main>

      <footer className="page-footer">
        <span>Thoughtful perspectives, brought together.</span>
        <span>Agent profiles and meetings are saved in this browser.</span>
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
      {showMeetingModal && (
        <MeetingEditorModal
          agents={agents}
          onClose={() => setShowMeetingModal(false)}
          onCreate={createMeeting}
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
                {meetingStatusLabel(meeting.status)}
              </span>
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
          <span className="profile-index">ADVISOR 0{index + 1}</span>
          <h2>{agent.name}</h2>
          <p>{agent.role}</p>
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
