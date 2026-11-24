import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type {
  BoardroomChatMessage,
  BoardroomEvent,
  BoardroomReport,
  BoardroomReportEvent,
  BoardroomReportType,
  Meeting,
  MeetingMode,
  MeetingStatus,
  ProviderAvailability,
} from '../../shared/boardroom'
import { streamBoardroom, streamBoardroomReport } from '../boardroomApi'
import { createId } from '../createId'
import Modal from './Modal'

interface MeetingRoomProps {
  meeting: Meeting
  providers: ProviderAvailability | null
  onBack: () => void
  onUpdate: (meeting: Meeting) => void
}

const CHAT_CONTEXT_LIMIT = 22_000

function statusLabel(status: MeetingStatus, mode: MeetingMode): string {
  if (mode === 'chat') {
    if (status === 'running') return 'Responding'
    if (status === 'interrupted') return 'Paused'
    return 'Chat open'
  }

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

function formatChatContext(
  meeting: Meeting,
  messages: BoardroomChatMessage[],
): string {
  const boardroomContext =
    meeting.task && meeting.task !== 'Ongoing boardroom chat'
      ? `Boardroom context:\n${meeting.task}\n\n`
      : ''
  const entries = messages.map((message) => {
    const speaker =
      message.role === 'user'
        ? 'User'
        : message.role === 'facilitator'
          ? `${message.agentName ?? 'Facilitator'} — synthesis`
          : `${message.agentName ?? 'Advisor'}${message.agentRole ? ` (${message.agentRole})` : ''}`
    return `${speaker}:\n${message.content}`
  })

  let context = ''
  for (let firstEntry = 0; firstEntry <= entries.length; firstEntry += 1) {
    const omitted = firstEntry > 0 ? 'Earlier messages omitted for context length.\n\n' : ''
    context = `${boardroomContext}${omitted}Conversation so far:\n${entries.slice(firstEntry).join('\n\n')}`
    if (context.length <= CHAT_CONTEXT_LIMIT || firstEntry >= entries.length) break
  }

  return context.slice(-CHAT_CONTEXT_LIMIT)
}

function reportTypeLabel(type: BoardroomReportType): string {
  switch (type) {
    case 'scope':
      return 'Scope document'
    case 'review':
      return 'Review document'
    case 'custom':
      return 'Custom report'
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
  const [chatDraft, setChatDraft] = useState('')
  const [reportSourceMessageId, setReportSourceMessageId] = useState<string | null>(null)
  const [reportType, setReportType] = useState<BoardroomReportType>('scope')
  const [reportTitle, setReportTitle] = useState('')
  const [reportInstructions, setReportInstructions] = useState('')
  const [reportProgress, setReportProgress] = useState('')
  const [reportError, setReportError] = useState('')
  const [reportDownloadError, setReportDownloadError] = useState('')
  const [isGeneratingReport, setIsGeneratingReport] = useState(false)
  const error = meeting.error
  const controllerRef = useRef<AbortController | null>(null)
  const reportControllerRef = useRef<AbortController | null>(null)
  const meetingRef = useRef(meeting)
  const chatEndRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    if (meeting.mode === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [meeting.chatMessages.length, meeting.mode, meeting.reports.length, statusMessage])

  useEffect(
    () => () => {
      controllerRef.current?.abort()
      reportControllerRef.current?.abort()
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
        setStatusMessage(
          meetingRef.current.mode === 'chat'
            ? 'Advisors are considering your message…'
            : `Round ${event.round} of ${event.totalRounds}`,
        )
        break
      case 'turn_start':
        setStatusMessage(
          meetingRef.current.mode === 'chat'
            ? `${event.agentName} is thinking…`
            : `Round ${event.round}: ${event.agentName} is thinking…`,
        )
        break
      case 'turn_complete':
        if (meetingRef.current.mode === 'chat') {
          updateMeeting({
            chatMessages: [
              ...meetingRef.current.chatMessages,
              {
                id: event.turn.id,
                role: 'agent',
                content: event.turn.content,
                createdAt: new Date().toISOString(),
                agentId: event.turn.agentId,
                agentName: event.turn.agentName,
                agentRole: event.turn.agentRole,
              },
            ],
          })
        } else {
          updateMeeting({
            transcript: [...meetingRef.current.transcript, event.turn],
          })
        }
        break
      case 'synthesis_start':
        setStatusMessage(`${event.agentName} is preparing the synthesis…`)
        break
      case 'synthesis_complete':
        if (meetingRef.current.mode === 'chat') {
          updateMeeting({
            synthesis: event.content,
            chatMessages: [
              ...meetingRef.current.chatMessages,
              {
                id: `synthesis-${createId()}`,
                role: 'facilitator',
                content: event.content,
                createdAt: new Date().toISOString(),
                agentId: event.agentId,
                agentName: event.agentName,
              },
            ],
          })
        } else {
          updateMeeting({ synthesis: event.content })
        }
        break
      case 'error':
        updateMeeting({ status: 'interrupted', error: event.message })
        break
      case 'done':
        updateMeeting({ status: 'completed', error: '' })
        setStatusMessage('Discussion complete')
        break
    }
  }

  async function startDiscussion() {
    const controller = new AbortController()
    controllerRef.current = controller
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
      setStatusMessage('')
      updateMeeting({ status: 'interrupted', error: message })
    } finally {
      controllerRef.current = null
      setIsRunning(false)
    }
  }

  async function sendChatMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const content = chatDraft.trim()
    if (
      !content ||
      isRunning ||
      meetingRef.current.status === 'running' ||
      missingProviders.length > 0
    ) {
      return
    }

    const currentMeeting = meetingRef.current
    const userMessage: BoardroomChatMessage = {
      id: createId(),
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    }
    updateMeeting({
      chatMessages: [...currentMeeting.chatMessages, userMessage],
      status: 'running',
      synthesis: '',
      error: '',
    })
    setChatDraft('')
    const controller = new AbortController()
    controllerRef.current = controller
    setIsRunning(true)
    setStatusMessage('Preparing the boardroom…')

    let completed = false
    let failed = false
    try {
      await streamBoardroom(
        {
          task: content,
          context: formatChatContext(currentMeeting, currentMeeting.chatMessages),
          agents: currentMeeting.agents,
          rounds: 1,
          facilitatorId: currentMeeting.facilitatorId,
        },
        controller.signal,
        (event) => {
          if (event.type === 'done') completed = true
          if (event.type === 'error') failed = true
          handleEvent(event)
        },
      )

      if (!completed && !failed && !controller.signal.aborted) {
        const message = 'The response ended before the board reached a conclusion.'
        setStatusMessage('')
        updateMeeting({ status: 'interrupted', error: message })
      }
    } catch (requestError) {
      const message =
        requestError instanceof DOMException && requestError.name === 'AbortError'
          ? 'Response stopped before completion.'
          : requestError instanceof Error
            ? requestError.message
            : 'The boardroom response failed.'
      setStatusMessage('')
      updateMeeting({ status: 'interrupted', error: message })
    } finally {
      controllerRef.current = null
      setIsRunning(false)
    }
  }

  function openReportModal(message: BoardroomChatMessage) {
    setReportSourceMessageId(message.id)
    setReportType('scope')
    setReportTitle(`${meetingRef.current.name} - Scope document`)
    setReportInstructions('')
    setReportProgress('')
    setReportError('')
  }

  function closeReportModal() {
    reportControllerRef.current?.abort()
    reportControllerRef.current = null
    setIsGeneratingReport(false)
    setReportSourceMessageId(null)
    setReportProgress('')
    setReportError('')
  }

  async function downloadReport(report: BoardroomReport) {
    setReportDownloadError('')
    try {
      const { downloadReportPdf } = await import('../reportPdf')
      downloadReportPdf(report)
    } catch (downloadError) {
      setReportDownloadError(
        downloadError instanceof Error
          ? `Could not create the PDF: ${downloadError.message}`
          : 'Could not create the PDF.',
      )
    }
  }

  async function generateReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const currentMeeting = meetingRef.current
    const sourceIndex = currentMeeting.chatMessages.findIndex(
      (message) => message.id === reportSourceMessageId,
    )
    if (
      sourceIndex < 0 ||
      !reportTitle.trim() ||
      missingProviders.length > 0 ||
      currentMeeting.status === 'running'
    ) {
      return
    }

    const context = formatChatContext(
      currentMeeting,
      currentMeeting.chatMessages.slice(0, sourceIndex + 1),
    )
    const controller = new AbortController()
    reportControllerRef.current = controller
    setIsGeneratingReport(true)
    setReportError('')
    setReportProgress('Preparing advisor contributions…')

    let completed = false
    let failed = false
    let generatedReport: BoardroomReport | null = null
    try {
      await streamBoardroomReport(
        {
          title: reportTitle.trim(),
          type: reportType,
          instructions: reportInstructions.trim(),
          context,
          agents: currentMeeting.agents,
          facilitatorId: currentMeeting.facilitatorId,
        },
        controller.signal,
        (event: BoardroomReportEvent) => {
          switch (event.type) {
            case 'section_start':
              setReportProgress(`${event.agentName} is drafting their report sections…`)
              break
            case 'section_complete':
              setReportProgress(`${event.agentName} has contributed their sections.`)
              break
            case 'facilitator_start':
              setReportProgress(`${event.agentName} is assembling the final report…`)
              break
            case 'report_complete': {
              const report: BoardroomReport = {
                id: createId(),
                title: reportTitle.trim(),
                type: reportType,
                content: event.content,
                createdAt: new Date().toISOString(),
              }
              generatedReport = report
              updateMeeting({
                reports: [...meetingRef.current.reports, report],
              })
              break
            }
            case 'error':
              failed = true
              setReportError(event.message)
              break
            case 'done':
              completed = true
              break
          }
        },
      )

      if (!completed && !failed && !controller.signal.aborted) {
        setReportError('The report ended before the facilitator completed it.')
      } else if (completed && generatedReport) {
        setReportSourceMessageId(null)
      }
    } catch (requestError) {
      if (!controller.signal.aborted) {
        setReportError(
          requestError instanceof Error
            ? requestError.message
            : 'The boardroom report failed.',
        )
      }
    } finally {
      reportControllerRef.current = null
      setIsGeneratingReport(false)
      setReportProgress('')
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
            <p className="section-kicker">
              {meeting.mode === 'chat' ? 'ONGOING BOARDROOM CHAT' : 'BOARDROOM MEETING'}
            </p>
            <h2>{meeting.name}</h2>
          </div>
          <span className={`meeting-status status-${meeting.status}`}>
            {isRunning && <span className="status-dot working" />}
            {statusLabel(meeting.status, meeting.mode)}
          </span>
        </div>
        {meeting.task !== 'Ongoing boardroom chat' && (
          <p className="meeting-agenda">{meeting.task}</p>
        )}
        <div className="meeting-participants">
          {meeting.agents.map((agent) => (
            <span className="participant-chip" key={agent.id}>
              <span>{agent.name.trim().charAt(0).toUpperCase() || 'A'}</span>
              {agent.name}
            </span>
          ))}
          <span className="meeting-rounds">
            {meeting.mode === 'chat'
              ? 'Ongoing chat · all advisors respond'
              : `${meeting.rounds} discussion rounds`}
          </span>
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
        {meeting.status === 'running' && !isRunning && (
          <div className="notice setup-notice">
            <strong>This discussion is running in another tab.</strong>
            <span>Its transcript and status will sync here automatically.</span>
          </div>
        )}
        {meeting.mode !== 'chat' && (
          <div className="meeting-run-bar">
            <span className="run-cost">
              {meeting.agents.length * meeting.rounds + 1} provider requests planned
            </span>
            {isRunning ? (
              <button className="secondary-button" onClick={stopDiscussion} type="button">
                Stop discussion
              </button>
            ) : meeting.status !== 'running' ? (
              <button
                className="primary-button"
                disabled={missingProviders.length > 0}
                onClick={() => void startDiscussion()}
                type="button"
              >
                {meeting.status === 'completed'
                  ? 'Run again'
                  : meeting.status === 'interrupted'
                    ? 'Restart discussion'
                    : 'Start discussion'}
              </button>
            ) : null}
          </div>
        )}
      </div>

      {statusMessage && (
        <div className="activity-status" aria-live="polite" role="status">
          <span className={isRunning ? 'activity-pulse' : 'activity-check'}>
            {isRunning ? '' : '✓'}
          </span>
          {statusMessage}
        </div>
      )}

      {meeting.mode === 'chat' ? (
        <>
          <div aria-label="Boardroom conversation" className="chat-thread">
            {meeting.chatMessages.length === 0 ? (
              <div className="chat-empty">
                <span className="empty-state-icon" aria-hidden="true">✳</span>
                <h3>Your boardroom is ready.</h3>
                <p>Send a message to get perspectives from your advisors and a shared recommendation.</p>
              </div>
            ) : (
              meeting.chatMessages.map((message) => (
                <article
                  className={`chat-message chat-message-${message.role}`}
                  key={message.id}
                >
                  {message.role !== 'user' && (
                    <span className={`chat-avatar ${message.role}`}>
                      {message.role === 'facilitator'
                        ? '✳'
                        : (message.agentName?.trim().charAt(0).toUpperCase() || 'A')}
                    </span>
                  )}
                  <div className="chat-message-body">
                    <span className="chat-speaker">
                      {message.role === 'user'
                        ? 'You'
                        : message.role === 'facilitator'
                          ? `Board synthesis · ${message.agentName ?? facilitator}`
                          : `${message.agentName ?? 'Advisor'}${message.agentRole ? ` · ${message.agentRole}` : ''}`}
                    </span>
                    <div className="chat-bubble">{message.content}</div>
                    {message.role === 'facilitator' && (
                      <button
                        className="text-button chat-report-button"
                        disabled={
                          isRunning ||
                          isGeneratingReport ||
                          meeting.status === 'running' ||
                          missingProviders.length > 0
                        }
                        onClick={() => openReportModal(message)}
                        type="button"
                      >
                        Generate report
                      </button>
                    )}
                  </div>
                </article>
              ))
            )}
            {meeting.reports.map((report) => (
              <article className="chat-report-card" key={report.id}>
                <div>
                  <span className="chat-report-kind">{reportTypeLabel(report.type)}</span>
                  <h3>{report.title}</h3>
                  <p>Generated {new Date(report.createdAt).toLocaleString()}</p>
                </div>
                <button
                  className="secondary-button"
                  onClick={() => void downloadReport(report)}
                  type="button"
                >
                  Download PDF
                </button>
              </article>
            ))}
            {reportDownloadError && (
              <p className="form-error" role="alert">{reportDownloadError}</p>
            )}
            {isRunning && (
              <div className="chat-thinking" role="status">
                <span className="activity-pulse" />
                {statusMessage || 'The board is thinking…'}
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <form className="chat-composer" onSubmit={sendChatMessage}>
            <label className="chat-composer-label" htmlFor="boardroom-chat-message">
              Message the board
            </label>
            <textarea
              id="boardroom-chat-message"
              maxLength={4_000}
              onChange={(event) => setChatDraft(event.target.value)}
              placeholder="Ask a question or share a follow-up…"
              rows={3}
              value={chatDraft}
            />
            <div className="chat-composer-footer">
              <span>
                Each message triggers {meeting.agents.length} advisor
                {meeting.agents.length === 1 ? '' : 's'} and a facilitator response.
              </span>
              {isRunning ? (
                <button className="secondary-button" onClick={stopDiscussion} type="button">
                  Stop response
                </button>
              ) : (
                <button
                  className="primary-button"
                  disabled={
                    !chatDraft.trim() ||
                    meeting.status === 'running' ||
                    isGeneratingReport ||
                    missingProviders.length > 0
                  }
                  type="submit"
                >
                  Send message
                </button>
              )}
            </div>
          </form>
        </>
      ) : meeting.transcript.length === 0 && !meeting.synthesis ? (
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
      {reportSourceMessageId && (
        <Modal title="Generate a boardroom report" onClose={closeReportModal}>
          <form className="modal-form" onSubmit={generateReport}>
            <label className="modal-field">
              Report type
              <select
                onChange={(change) => {
                  const type =
                    change.target.value === 'review' || change.target.value === 'custom'
                      ? change.target.value
                      : 'scope'
                  setReportType(type)
                  setReportTitle(
                    `${meetingRef.current.name} - ${reportTypeLabel(type)}`,
                  )
                }}
                value={reportType}
              >
                <option value="scope">Scope document</option>
                <option value="review">Review document</option>
                <option value="custom">Custom report</option>
              </select>
            </label>
            <label className="modal-field">
              Report title
              <input
                maxLength={120}
                onChange={(change) => setReportTitle(change.target.value)}
                required
                value={reportTitle}
              />
            </label>
            <label className="modal-field">
              Instructions (optional)
              <textarea
                maxLength={4_000}
                onChange={(change) => setReportInstructions(change.target.value)}
                placeholder="Add project-specific requirements, criteria, or sections."
                rows={4}
                value={reportInstructions}
              />
            </label>
            <p className="report-cost-notice">
              Each selected advisor drafts relevant sections, then the facilitator assembles
              them. This makes {meeting.agents.length + 1} provider requests and may incur
              charges.
            </p>
            {reportProgress && (
              <p className="report-progress" role="status">{reportProgress}</p>
            )}
            {reportError && <p className="form-error" role="alert">{reportError}</p>}
            <div className="modal-actions">
              <span className="meeting-selection-count">
                {meeting.agents.length} advisors + facilitator
              </span>
              <div className="modal-actions-end">
                <button
                  className="secondary-button"
                  onClick={closeReportModal}
                  type="button"
                >
                  {isGeneratingReport ? 'Cancel generation' : 'Cancel'}
                </button>
                <button
                  className="primary-button"
                  disabled={
                    !reportTitle.trim() ||
                    isGeneratingReport ||
                    missingProviders.length > 0 ||
                    meeting.status === 'running'
                  }
                  type="submit"
                >
                  {isGeneratingReport ? 'Generating…' : 'Generate report'}
                </button>
              </div>
            </div>
          </form>
        </Modal>
      )}
    </section>
  )
}

export default MeetingRoom
