import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type {
  AgentConfig,
  BoardroomEvent,
  BoardroomTurn,
  Provider,
  ProviderAvailability,
} from '../shared/boardroom'
import './App.css'

const AGENT_STORAGE_KEY = 'boardmeetings.agents'
const SELECTED_STORAGE_KEY = 'boardmeetings.selectedAgents'

const DEFAULT_AGENTS: AgentConfig[] = [
  {
    id: 'strategy-advisor',
    name: 'Strategy advisor',
    role: 'Strategy & market perspective',
    provider: 'openai',
    model: 'gpt-6.2-sol',
    instructions: 'Look for strategic opportunities, tradeoffs, and second-order effects.',
  },
  {
    id: 'risk-advisor',
    name: 'Risk advisor',
    role: 'Risk & governance',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    instructions: 'Surface risks, ethical considerations, and governance implications.',
  },
]

type ProviderState = 'checking' | 'connected' | 'disconnected'
type AuthState = 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readProviderAvailability(signal?: AbortSignal): Promise<ProviderAvailability> {
  const response = await fetch('/api/providers', { signal })
  if (!response.ok) throw new Error(`Provider status returned ${response.status}`)

  const result: unknown = await response.json()
  if (
    !isRecord(result) ||
    !isRecord(result.providers) ||
    typeof result.providers.openai !== 'boolean' ||
    typeof result.providers.anthropic !== 'boolean'
  ) {
    throw new Error('Provider status response was invalid.')
  }

  return {
    openai: result.providers.openai,
    anthropic: result.providers.anthropic,
  }
}

function isAgentConfig(value: unknown): value is AgentConfig {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.role === 'string' &&
    (value.provider === 'openai' || value.provider === 'anthropic') &&
    typeof value.model === 'string' &&
    typeof value.instructions === 'string'
  )
}

function loadAgents(): AgentConfig[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(AGENT_STORAGE_KEY) ?? 'null')
    if (Array.isArray(stored) && stored.length > 0 && stored.every(isAgentConfig)) {
      return stored
    }
  } catch {
    return DEFAULT_AGENTS
  }
  return DEFAULT_AGENTS
}

function loadSelectedIds(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SELECTED_STORAGE_KEY) ?? 'null')
    if (Array.isArray(stored) && stored.every((id) => typeof id === 'string')) {
      return stored
    }
  } catch {
    return DEFAULT_AGENTS.map((agent) => agent.id)
  }
  return DEFAULT_AGENTS.map((agent) => agent.id)
}

function readEvent(value: unknown): BoardroomEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Received an invalid event from the boardroom.')
  }

  if (value.type === 'round_start' && typeof value.round === 'number' && typeof value.totalRounds === 'number') {
    return { type: value.type, round: value.round, totalRounds: value.totalRounds }
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
  if (value.type === 'turn_complete' && isRecord(value.turn)) {
    const turn = value.turn
    if (
      typeof turn.id === 'string' &&
      typeof turn.agentId === 'string' &&
      typeof turn.agentName === 'string' &&
      typeof turn.agentRole === 'string' &&
      typeof turn.round === 'number' &&
      typeof turn.content === 'string'
    ) {
      return {
        type: value.type,
        turn: {
          id: turn.id,
          agentId: turn.agentId,
          agentName: turn.agentName,
          agentRole: turn.agentRole,
          round: turn.round,
          content: turn.content,
        },
      }
    }
  }
  if (
    value.type === 'synthesis_start' &&
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
    value.type === 'synthesis_complete' &&
    typeof value.agentId === 'string' &&
    typeof value.agentName === 'string' &&
    typeof value.content === 'string'
  ) {
    return {
      type: value.type,
      agentId: value.agentId,
      agentName: value.agentName,
      content: value.content,
    }
  }
  if (value.type === 'error' && typeof value.message === 'string') {
    return { type: value.type, message: value.message }
  }
  if (value.type === 'done') return { type: value.type }

  throw new Error('Received an invalid event from the boardroom.')
}

function providerModel(provider: Provider): string {
  return provider === 'openai' ? 'gpt-6.2-sol' : 'claude-sonnet-5-5'
}

function App() {
  const [authState, setAuthState] = useState<AuthState>('checking')
  const [loginPassword, setLoginPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [logoutError, setLogoutError] = useState('')
  const [agents, setAgents] = useState<AgentConfig[]>(loadAgents)
  const [selectedIds, setSelectedIds] = useState<string[]>(loadSelectedIds)
  const [facilitatorId, setFacilitatorId] = useState(DEFAULT_AGENTS[0].id)
  const [task, setTask] = useState('')
  const [rounds, setRounds] = useState(2)
  const [providers, setProviders] = useState<ProviderAvailability | null>(null)
  const [providerState, setProviderState] = useState<ProviderState>('checking')
  const [connectionError, setConnectionError] = useState('')
  const [storageError, setStorageError] = useState('')
  const [transcript, setTranscript] = useState<BoardroomTurn[]>([])
  const [synthesis, setSynthesis] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)

  const selectedAgents = useMemo(
    () => agents.filter((agent) => selectedIds.includes(agent.id)),
    [agents, selectedIds],
  )
  const activeFacilitatorId = selectedAgents.some((agent) => agent.id === facilitatorId)
    ? facilitatorId
    : (selectedAgents[0]?.id ?? '')
  const missingProviders = [
    ...new Set(
      selectedAgents
        .filter((agent) => !providers?.[agent.provider])
        .map((agent) => agent.provider),
    ),
  ]
  const requestCount = selectedAgents.length * rounds + 1

  function saveSettings(nextAgents: AgentConfig[], nextSelectedIds: string[]) {
    try {
      localStorage.setItem(AGENT_STORAGE_KEY, JSON.stringify(nextAgents))
      localStorage.setItem(SELECTED_STORAGE_KEY, JSON.stringify(nextSelectedIds))
      setStorageError('')
    } catch {
      setStorageError('Agent settings could not be saved in this browser.')
    }
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

        setAuthState('authenticated')
        const availability = await readProviderAvailability(controller.signal)
        setProviders(availability)
        setProviderState('connected')
        setConnectionError('')
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') {
          return
        }
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

  useEffect(
    () => () => {
      controllerRef.current?.abort()
    },
    [],
  )

  function updateAgent(id: string, changes: Partial<AgentConfig>) {
    const updatedAgents = agents.map((agent) =>
      agent.id === id ? { ...agent, ...changes } : agent,
    )
    setAgents(updatedAgents)
    saveSettings(updatedAgents, selectedIds)
  }

  function toggleAgent(id: string) {
    const updatedSelectedIds = selectedIds.includes(id)
      ? selectedIds.filter((selectedId) => selectedId !== id)
      : [...selectedIds, id]
    setSelectedIds(updatedSelectedIds)
    saveSettings(agents, updatedSelectedIds)
  }

  function addAgent() {
    if (agents.length >= 5) return

    const agent: AgentConfig = {
      id: crypto.randomUUID(),
      name: `Advisor ${agents.length + 1}`,
      role: 'Add a perspective',
      provider: 'openai',
      model: providerModel('openai'),
      instructions: '',
    }
    const updatedAgents = [...agents, agent]
    const updatedSelectedIds = [...selectedIds, agent.id]
    setAgents(updatedAgents)
    setSelectedIds(updatedSelectedIds)
    saveSettings(updatedAgents, updatedSelectedIds)
  }

  function removeAgent(id: string) {
    const updatedAgents = agents.filter((agent) => agent.id !== id)
    const updatedSelectedIds = selectedIds.filter((selectedId) => selectedId !== id)
    setAgents(updatedAgents)
    setSelectedIds(updatedSelectedIds)
    saveSettings(updatedAgents, updatedSelectedIds)
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

  function handleEvent(event: BoardroomEvent) {
    switch (event.type) {
      case 'round_start':
        setStatus(`Round ${event.round} of ${event.totalRounds}`)
        break
      case 'turn_start':
        setStatus(`Round ${event.round}: ${event.agentName} is thinking…`)
        break
      case 'turn_complete':
        setTranscript((current) => [...current, event.turn])
        break
      case 'synthesis_start':
        setStatus(`${event.agentName} is preparing the board synthesis…`)
        break
      case 'synthesis_complete':
        setSynthesis(event.content)
        break
      case 'error':
        setError(event.message)
        break
      case 'done':
        setStatus('Deliberation complete')
        break
    }
  }

  async function startBoardroom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setTranscript([])
    setSynthesis('')
    setStatus('Preparing the boardroom…')
    setIsRunning(true)

    const controller = new AbortController()
    controllerRef.current = controller

    try {
      const response = await fetch('/api/boardrooms/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task,
          agents: selectedAgents,
          rounds,
          facilitatorId: activeFacilitatorId,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const result: unknown = await response.json().catch(() => null)
        const message =
          isRecord(result) && typeof result.error === 'string'
            ? result.error
            : `The boardroom request failed (${response.status}).`
        throw new Error(message)
      }
      if (!response.body) throw new Error('The boardroom stream is unavailable.')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      function processLine(line: string) {
        if (line.trim()) handleEvent(readEvent(JSON.parse(line) as unknown))
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
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') {
        setStatus('Discussion stopped')
      } else {
        setError(
          requestError instanceof Error ? requestError.message : 'The boardroom run failed.',
        )
        setStatus('')
      }
    } finally {
      controllerRef.current = null
      setIsRunning(false)
    }
  }

  function stopBoardroom() {
    controllerRef.current?.abort()
  }

  const canRun =
    providerState === 'connected' &&
    selectedAgents.length > 0 &&
    missingProviders.length === 0 &&
    task.trim().length > 0

  if (authState !== 'authenticated') {
    return (
      <main className="auth-shell">
        <a className="brand" href="/" aria-label="BoardMeetings home">
          <span className="brand-mark" aria-hidden="true">B</span>
          <span>boardmeetings</span>
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
              {connectionError || 'The BoardMeetings server could not be reached.'}
            </p>
          )}
          {authState === 'unauthenticated' && (
            <>
              <p className="auth-copy">
                Enter the shared access password configured by the BoardMeetings host.
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
                <button className="run-button" type="submit">Enter boardroom</button>
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
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="BoardMeetings home">
          <span className="brand-mark" aria-hidden="true">B</span>
          <span>boardmeetings</span>
        </a>
        <div className="topbar-actions">
          <div className={`service-status ${providerState}`}>
            <span className="status-dot" />
            {providerState === 'checking' && 'Connecting'}
            {providerState === 'connected' && 'Boardroom ready'}
            {providerState === 'disconnected' && 'Server unavailable'}
          </div>
          <button className="sign-out-button" onClick={() => void signOut()} type="button">
            Sign out
          </button>
          {logoutError && <span className="logout-error" role="alert">{logoutError}</span>}
        </div>
      </header>

      <section className="page-intro">
        <div>
          <p className="eyebrow">YOUR AI MEETING HUB</p>
          <h1>Bring the right minds to the table.</h1>
          <p className="intro-copy">
            Give your advisors a task. They’ll bring different perspectives, challenge
            assumptions, and work toward a clear conclusion.
          </p>
        </div>
        <div className="intro-note">
          <span className="intro-note-mark" aria-hidden="true">✳</span>
          <span>Different models.<br />One considered answer.</span>
        </div>
      </section>

      {connectionError && (
        <div className="notice error-notice" role="alert">
          <strong>Couldn’t connect to the BoardMeetings server.</strong>
          <span>{connectionError}</span>
        </div>
      )}

      {providerState === 'connected' && providers && !providers.openai && !providers.anthropic && (
        <div className="notice setup-notice">
          <strong>Connect an AI provider to start a discussion.</strong>
          <span>
            Add <code>OPENAI_API_KEY</code> and/or <code>ANTHROPIC_API_KEY</code> to the
            server’s <code>.env</code> file, then restart BoardMeetings.
          </span>
        </div>
      )}

      {storageError && <p className="storage-notice">{storageError}</p>}

      <div className="workspace">
        <aside className="agent-sidebar">
          <div className="sidebar-heading">
            <div>
              <p className="section-kicker">THE ROSTER</p>
              <h2>Your advisors</h2>
            </div>
            <span className="agent-count">{selectedAgents.length} in room</span>
          </div>
          <p className="sidebar-intro">
            Choose a provider and perspective for each agent. Select who joins this
            boardroom.
          </p>

          <div className="agent-list">
            {agents.map((agent, index) => (
              <article className="agent-card" key={agent.id}>
                <div className="agent-card-top">
                  <label className="agent-toggle">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(agent.id)}
                      onChange={() => toggleAgent(agent.id)}
                      aria-label={`Add ${agent.name} to this boardroom`}
                    />
                    <span className="toggle-track" aria-hidden="true" />
                    <span className="agent-number">0{index + 1}</span>
                  </label>
                  <button
                    className="icon-button remove-agent"
                    type="button"
                    onClick={() => removeAgent(agent.id)}
                    aria-label={`Remove ${agent.name}`}
                    title="Remove advisor"
                  >
                    ×
                  </button>
                </div>

                <label className="field-label">
                  Agent name
                  <input
                    value={agent.name}
                    maxLength={80}
                    onChange={(change) => updateAgent(agent.id, { name: change.target.value })}
                    aria-label={`Name for advisor ${index + 1}`}
                  />
                </label>
                <label className="field-label">
                  Perspective
                  <input
                    value={agent.role}
                    maxLength={120}
                    onChange={(change) => updateAgent(agent.id, { role: change.target.value })}
                    aria-label={`Perspective for ${agent.name}`}
                  />
                </label>

                <div className="agent-provider-row">
                  <label className="field-label">
                    Provider
                    <select
                      value={agent.provider}
                      onChange={(change) => {
                        const provider = change.target.value as Provider
                        updateAgent(agent.id, {
                          provider,
                          model: providerModel(provider),
                        })
                      }}
                      aria-label={`Provider for ${agent.name}`}
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                    </select>
                  </label>
                  <span
                    className={`provider-key-status ${providers?.[agent.provider] ? 'configured' : ''}`}
                    title={
                      providers?.[agent.provider]
                        ? 'Provider API key configured'
                        : 'Provider API key not configured'
                    }
                  >
                    <span className="status-dot" />
                    {providers?.[agent.provider] ? 'Ready' : 'No key'}
                  </span>
                </div>
                <label className="field-label">
                  Model ID
                  <input
                    value={agent.model}
                    maxLength={120}
                    onChange={(change) => updateAgent(agent.id, { model: change.target.value })}
                    aria-label={`Model ID for ${agent.name}`}
                  />
                </label>
                <details className="agent-instructions">
                  <summary>Agent instructions</summary>
                  <label className="field-label">
                    Expertise and guidance
                    <textarea
                      value={agent.instructions}
                      rows={3}
                      maxLength={2_000}
                      onChange={(change) =>
                        updateAgent(agent.id, { instructions: change.target.value })
                      }
                      placeholder="What should this advisor pay particular attention to?"
                    />
                  </label>
                </details>
              </article>
            ))}
          </div>

          <button
            className="add-agent-button"
            type="button"
            onClick={addAgent}
            disabled={agents.length >= 5}
          >
            <span aria-hidden="true">+</span>
            Add an advisor
            <span className="add-agent-limit">{agents.length}/5</span>
          </button>
          <p className="sidebar-footnote">
            Agent settings are saved in this browser. API keys stay on the server.
          </p>
        </aside>

        <section className="boardroom">
          <div className="boardroom-heading">
            <div className="boardroom-title">
              <span className="room-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="M4 10.5h16M6.5 10.5v8m5.5-8v8m5.5-8v8M3.5 20.5h17M5 7l7-3.5L19 7v3.5H5V7Z" />
                </svg>
              </span>
              <div>
                <p className="section-kicker">LIVE SESSION</p>
                <h2>Boardroom</h2>
              </div>
            </div>
            <span className="session-state">
              <span className={`status-dot ${isRunning ? 'working' : ''}`} />
              {isRunning ? 'In session' : 'Ready to convene'}
            </span>
          </div>

          <form className="task-form" onSubmit={startBoardroom}>
            <label htmlFor="meeting-task">What should the board work through?</label>
            <textarea
              id="meeting-task"
              value={task}
              onChange={(change) => setTask(change.target.value)}
              placeholder="Describe a decision, challenge, or question for your advisors…"
              rows={4}
              maxLength={8_000}
              disabled={isRunning}
              required
            />
            <div className="run-options">
              <label className="option-field">
                <span>Discussion rounds</span>
                <select
                  value={rounds}
                  onChange={(change) => setRounds(Number(change.target.value))}
                  disabled={isRunning}
                >
                  <option value={1}>1 round</option>
                  <option value={2}>2 rounds</option>
                  <option value={3}>3 rounds</option>
                </select>
              </label>
              <label className="option-field facilitator-field">
                <span>Facilitator</span>
                <select
                  value={activeFacilitatorId}
                  onChange={(change) => setFacilitatorId(change.target.value)}
                  disabled={isRunning || selectedAgents.length === 0}
                >
                  {selectedAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </select>
              </label>
              <div className="run-actions">
                {isRunning ? (
                  <button className="run-button stop-button" type="button" onClick={stopBoardroom}>
                    Stop discussion
                  </button>
                ) : (
                  <button className="run-button" type="submit" disabled={!canRun}>
                    <span aria-hidden="true">✳</span>
                    Convene board
                  </button>
                )}
              </div>
            </div>
            <p className="cost-note">
              One provider request per agent per round, plus one final synthesis ({requestCount} total).
              Provider usage may incur charges.
            </p>
            {missingProviders.length > 0 && providers && (
              <p className="inline-warning" role="status">
                Configure {missingProviders.map((provider) => provider === 'openai' ? 'OpenAI' : 'Anthropic').join(' and ')} to use the selected advisors.
              </p>
            )}
          </form>

          {status && (
            <div className="activity-status" role="status" aria-live="polite">
              <span className={isRunning ? 'activity-pulse' : 'activity-check'}>
                {isRunning ? '' : '✓'}
              </span>
              {status}
            </div>
          )}
          {error && <div className="notice error-notice run-error" role="alert">{error}</div>}

          {transcript.length === 0 && !synthesis && !isRunning && !error ? (
            <div className="empty-boardroom">
              <div className="empty-illustration" aria-hidden="true">
                <span>◌</span>
                <i />
                <i />
                <i />
              </div>
              <h3>A good discussion starts with a good question.</h3>
              <p>
                Add your task above and bring your chosen advisors together. Their
                conversation and shared conclusion will appear here.
              </p>
            </div>
          ) : (
            <div className="discussion">
              {transcript.map((turn) => (
                <article className="turn-card" key={turn.id}>
                  <div className="turn-heading">
                    <span className="turn-avatar">{turn.agentName.charAt(0).toUpperCase()}</span>
                    <div>
                      <strong>{turn.agentName}</strong>
                      <span>{turn.agentRole} · Round {turn.round}</span>
                    </div>
                  </div>
                  <p>{turn.content}</p>
                </article>
              ))}
              {synthesis && (
                <article className="synthesis-card">
                  <div className="synthesis-heading">
                    <span className="synthesis-mark" aria-hidden="true">✳</span>
                    <div>
                      <p className="section-kicker">THE BOARD’S CONCLUSION</p>
                      <h3>Synthesis by {selectedAgents.find((agent) => agent.id === activeFacilitatorId)?.name ?? 'facilitator'}</h3>
                    </div>
                  </div>
                  <div className="synthesis-content">{synthesis}</div>
                </article>
              )}
            </div>
          )}
        </section>
      </div>

      <footer className="page-footer">
        <span>Thoughtful perspectives, brought together.</span>
        <span>AI advisors can be wrong. Use judgment for important decisions.</span>
      </footer>
    </main>
  )
}

export default App
