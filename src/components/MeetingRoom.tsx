import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  BoardroomEvent,
  Meeting,
  MeetingStatus,
  ProviderAvailability,
} from '../../shared/boardroom'
import { streamBoardroom } from '../boardroomApi'

interface MeetingRoomProps {
  meeting: Meeting
  providers: ProviderAvailability | null
  onBack: () => void
  onUpdate: (meeting: Meeting) => void
}

function statusLabel(status: MeetingStatus): string {
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

function providerLabel(provider: Meeting['agents'][number]['provider']): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI'
    case 'anthropic':
      return 'Anthropic'
    case 'openrouter':
      return 'OpenRouter'
  }
}

function MeetingRoom({ meeting, providers, onBack, onUpdate }: MeetingRoomProps) {
  const [isRunning, setIsRunning] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [error, setError] = useState(meeting.error)
  const controllerRef = useRef<AbortController | null>(null)
  const meetingRef = useRef(meeting)
  const missingProviders = useMemo(
    () => [
      ...new Set(
        meeting.agents
          .filter((agent) => !providers?.[agent.provider])
          .map((agent) => agent.provider),
      ),
    ],
    [meeting.agents, providers],
  )

  useEffect(() => {
    meetingRef.current = meeting
  }, [meeting])

  useEffect(
    () => () => {
      controllerRef.current?.abort()
    },
    [],
  )

  function updateMeeting(changes: Partial<Meeting>) {
    const updated = {
      ...meetingRef.current,
      ...changes,
      updatedAt: new Date().toISOString(),
    }
    meetingRef.current = updated
    onUpdate(updated)
  }

  function handleEvent(event: BoardroomEvent) {
    switch (event.type) {
      case 'round_start':
        setStatusMessage(`Round ${event.round} of ${event.totalRounds}`)
        break
      case 'turn_start':
        setStatusMessage(`Round ${event.round}: ${event.agentName} is thinking…`)
        break
      case 'turn_complete':
        updateMeeting({
          transcript: [...meetingRef.current.transcript, event.turn],
        })
        break
      case 'synthesis_start':
        setStatusMessage(`${event.agentName} is preparing the synthesis…`)
        break
      case 'synthesis_complete':
        updateMeeting({ synthesis: event.content })
        break
      case 'error':
        setError(event.message)
        updateMeeting({ status: 'interrupted', error: event.message })
        break
      case 'done':
        updateMeeting({ status: 'completed', error: '' })
        setError('')
        setStatusMessage('Discussion complete')
        break
    }
  }

  async function startDiscussion() {
    const controller = new AbortController()
    controllerRef.current = controller
    setError('')
    setIsRunning(true)
    setStatusMessage('Preparing the boardroom…')
    updateMeeting({
      status: 'running',
      transcript: [],
      synthesis: '',
      error: '',
    })

    let completed = false
    let failed = false
    try {
      await streamBoardroom(
        {
          task: meeting.task,
          agents: meeting.agents,
          rounds: meeting.rounds,
          facilitatorId: meeting.facilitatorId,
        },
        controller.signal,
        (event) => {
          if (event.type === 'done') completed = true
          if (event.type === 'error') failed = true
          handleEvent(event)
        },
      )

      if (!completed && !failed && !controller.signal.aborted) {
        const message = 'The discussion ended before a conclusion was received.'
        setError(message)
        setStatusMessage('')
        updateMeeting({ status: 'interrupted', error: message })
      }
    } catch (requestError) {
      const message =
        requestError instanceof DOMException && requestError.name === 'AbortError'
          ? 'Discussion stopped before completion.'
          : requestError instanceof Error
            ? requestError.message
            : 'The boardroom run failed.'
      setError(message)
      setStatusMessage('')
      updateMeeting({ status: 'interrupted', error: message })
    } finally {
      controllerRef.current = null
      setIsRunning(false)
    }
  }

  function stopDiscussion() {
    controllerRef.current?.abort()
  }

  const facilitator =
    meeting.agents.find((agent) => agent.id === meeting.facilitatorId)?.name ?? 'Facilitator'

  return (
    <section className="meeting-room">
      <div className="meeting-room-heading">
        <button className="back-button" onClick={onBack} type="button">
          <span aria-hidden="true">←</span> All meetings
        </button>
        <div className="meeting-room-title">
          <div>
            <p className="section-kicker">BOARDROOM MEETING</p>
            <h2>{meeting.name}</h2>
          </div>
          <span className={`meeting-status status-${meeting.status}`}>
            {isRunning && <span className="status-dot working" />}
            {statusLabel(meeting.status)}
          </span>
        </div>
        <p className="meeting-agenda">{meeting.task}</p>
        <div className="meeting-participants">
          {meeting.agents.map((agent) => (
            <span className="participant-chip" key={agent.id}>
              <span>{agent.name.trim().charAt(0).toUpperCase() || 'A'}</span>
              {agent.name}
            </span>
          ))}
          <span className="meeting-rounds">{meeting.rounds} discussion rounds</span>
        </div>
        {missingProviders.length > 0 && (
          <div className="notice setup-notice">
            <strong>Provider access is needed to start this discussion.</strong>
            <span>
              Configure {missingProviders.map(providerLabel).join(' and ')} on the server,
              or edit the meeting’s agent selection.
            </span>
          </div>
        )}
        {error && <div className="notice error-notice" role="alert">{error}</div>}
        <div className="meeting-run-bar">
          <span className="run-cost">
            {meeting.agents.length * meeting.rounds + 1} provider requests planned
          </span>
          {isRunning ? (
            <button className="secondary-button" onClick={stopDiscussion} type="button">
              Stop discussion
            </button>
          ) : meeting.status !== 'completed' ? (
            <button
              className="primary-button"
              disabled={missingProviders.length > 0}
              onClick={() => void startDiscussion()}
              type="button"
            >
              {meeting.status === 'interrupted' ? 'Restart discussion' : 'Start discussion'}
            </button>
          ) : null}
        </div>
      </div>

      {statusMessage && (
        <div className="activity-status" aria-live="polite" role="status">
          <span className={isRunning ? 'activity-pulse' : 'activity-check'}>
            {isRunning ? '' : '✓'}
          </span>
          {statusMessage}
        </div>
      )}

      {meeting.transcript.length === 0 && !meeting.synthesis ? (
        <div className="empty-boardroom">
          <div className="empty-illustration" aria-hidden="true">
            <span>◌</span><i /><i /><i />
          </div>
          <h3>Your boardroom is ready.</h3>
          <p>Start the discussion when you’re ready. Each advisor will share their perspective.</p>
        </div>
      ) : (
        <div className="discussion">
          {meeting.transcript.map((turn) => (
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
          {meeting.synthesis && (
            <article className="synthesis-card">
              <div className="synthesis-heading">
                <span className="synthesis-mark" aria-hidden="true">✳</span>
                <div>
                  <p className="section-kicker">THE BOARD’S CONCLUSION</p>
                  <h3>Synthesis by {facilitator}</h3>
                </div>
              </div>
              <div className="synthesis-content">{meeting.synthesis}</div>
            </article>
          )}
        </div>
      )}
    </section>
  )
}

export default MeetingRoom
