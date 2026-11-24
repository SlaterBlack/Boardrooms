import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import type {
  BoardroomChatMessage,
  BoardroomEvent,
  BoardroomReport,
  BoardroomReportEvent,
  BoardroomReportType,
  ChatAgentRole,
  Meeting,
  MeetingMode,
  MeetingStatus,
  ProviderAvailability,
} from '../../shared/boardroom'
import { isSecureImageUrl, resolveAgentMention } from '../../shared/chat'
import { streamBoardroom, streamBoardroomReport } from '../boardroomApi'
import { createId } from '../createId'
import Modal from './Modal'

interface MeetingRoomProps {
  meeting: Meeting
  providers: ProviderAvailability | null
  onBack: () => void
  onEdit: () => void
  onUpdate: (meeting: Meeting) => void
}

const CHAT_CONTEXT_LIMIT = 22_000
type DocumentTab = 'chat' | 'report'
type ImageFlavor = 'photo' | 'sublime' | 'photo_denoiser'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ActiveMention {
  start: number
  end: number
  query: string
}

function getActiveMention(value: string, cursor: number): ActiveMention | null {
  const prefix = value.slice(0, cursor)
  const match = /(?:^|\s)@(?:\{([^}]*)|([^\s{}]*))$/.exec(prefix)
  if (!match) return null
  return {
    start: prefix.length - match[0].length + match[0].lastIndexOf('@'),
    end: cursor,
    query: match[1] ?? match[2] ?? '',
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Could not read the selected image.'))
    }, { once: true })
    reader.addEventListener(
      'error',
      () => reject(new Error('Could not read the selected image.')),
      { once: true },
    )
    reader.readAsDataURL(file)
  })
}

function chatRoleLabel(role: ChatAgentRole | undefined): string {
  switch (role) {
    case 'advisor':
      return 'Meeting Member'
    case 'director':
      return 'Orchestrator'
    case 'researcher':
      return 'Researcher'
    case 'facilitator':
      return 'Facilitator'
    case 'critic':
      return 'Critic'
    case 'synthesizer':
      return 'Synthesizer'
    case 'image_processor':
      return 'Image processor'
    case 'image_generator':
      return 'Image generator'
    case 'image_analyser':
      return 'Image analyser'
    case 'report_formatter':
      return 'Document formatter'
    case 'executor':
      return 'Executor'
    default:
      return 'Meeting Member'
  }
}

function renderMarkdownInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_)/g)
    .map((part, index) => {
      if (
        (part.startsWith('**') && part.endsWith('**')) ||
        (part.startsWith('__') && part.endsWith('__'))
      ) {
        return <strong key={index}>{part.slice(2, -2)}</strong>
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return <code key={index}>{part.slice(1, -1)}</code>
      }
      if (
        (part.startsWith('*') && part.endsWith('*')) ||
        (part.startsWith('_') && part.endsWith('_'))
      ) {
        return <em key={index}>{part.slice(1, -1)}</em>
      }
      return part
    })
}

function splitMarkdownTableRow(line: string): string[] {
  const content = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  const cells: string[] = []
  let cell = ''
  let inCode = false

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (character === '\\' && content[index + 1] === '|') {
      cell += '|'
      index += 1
    } else if (character === '`') {
      inCode = !inCode
      cell += character
    } else if (character === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += character
    }
  }
  cells.push(cell.trim())
  return cells
}

function isMarkdownTableSeparator(cells: string[]): boolean {
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function startsMarkdownTable(lines: string[], index: number): boolean {
  const headers = splitMarkdownTableRow(lines[index] ?? '')
  const separator = lines[index + 1]
    ? splitMarkdownTableRow(lines[index + 1])
    : []
  return headers.length > 1 && isMarkdownTableSeparator(separator)
}

function markdownTableAlignment(separator: string | undefined): 'left' | 'center' | 'right' {
  const left = separator?.startsWith(':') ?? false
  const right = separator?.endsWith(':') ?? false
  if (left && right) return 'center'
  if (right) return 'right'
  return 'left'
}

function renderReportMarkdown(content: string): ReactNode[] {
  const lines = content.split(/\r?\n/)
  const blocks: ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index].trim()
    if (!line) {
      index += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const text = renderMarkdownInline(heading[2])
      const Heading = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      blocks.push(createElement(Heading, { key: `heading-${index}` }, text))
      index += 1
      continue
    }

    if (startsMarkdownTable(lines, index)) {
      const headers = splitMarkdownTableRow(line)
      const separators = splitMarkdownTableRow(lines[index + 1])
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(splitMarkdownTableRow(lines[index]))
        index += 1
      }
      blocks.push(
        <div className="report-preview-table-wrap" key={`table-${index}`}>
          <table>
            <thead>
              <tr>
                {headers.map((cell, cellIndex) => (
                  <th
                    key={cellIndex}
                    style={{ textAlign: markdownTableAlignment(separators[cellIndex]) }}
                  >
                    {renderMarkdownInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_, cellIndex) => (
                    <td
                      key={cellIndex}
                      style={{ textAlign: markdownTableAlignment(separators[cellIndex]) }}
                    >
                      {renderMarkdownInline(row[cellIndex] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    const listMatch = /^([-*+])\s+(.+)$/.exec(line)
    if (listMatch) {
      const items: string[] = []
      while (index < lines.length) {
        const item = /^[-*+]\s+(.+)$/.exec(lines[index].trim())
        if (!item) break
        items.push(item[1])
        index += 1
      }
      blocks.push(
        <ul key={`list-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderMarkdownInline(item)}</li>
          ))}
        </ul>,
      )
      continue
    }

    const paragraph = [line]
    index += 1
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6})\s+/.test(lines[index].trim()) &&
      !/^[-*+]\s+/.test(lines[index].trim()) &&
      !startsMarkdownTable(lines, index)
    ) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    blocks.push(<p key={`paragraph-${index}`}>{renderMarkdownInline(paragraph.join(' '))}</p>)
  }

  return blocks
}

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
    case 'magnific':
      return 'Magnific'
  }
}

function MeetingRoom({ meeting, providers, onBack, onEdit, onUpdate }: MeetingRoomProps) {
  const [isRunning, setIsRunning] = useState(false)
  const [runStatusError, setRunStatusError] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [chatDraft, setChatDraft] = useState('')
  const [analysisImageFile, setAnalysisImageFile] = useState<File | null>(null)
  const [analysisImageError, setAnalysisImageError] = useState('')
  const [chatCaretPosition, setChatCaretPosition] = useState(0)
  const [mentionSuggestionIndex, setMentionSuggestionIndex] = useState(0)
  const [dismissMentionSuggestions, setDismissMentionSuggestions] = useState(false)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imageScaleFactor, setImageScaleFactor] = useState(2)
  const [imageFlavor, setImageFlavor] = useState<ImageFlavor>('photo')
  const [isUpscaling, setIsUpscaling] = useState(false)
  const [imageProcessingError, setImageProcessingError] = useState('')
  const [imageProcessingStatus, setImageProcessingStatus] = useState('')
  const [documentTab, setDocumentTab] = useState<DocumentTab>('chat')
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
  const imageControllerRef = useRef<AbortController | null>(null)
  const meetingRef = useRef(meeting)
  const onUpdateRef = useRef(onUpdate)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const analysisImageInputRef = useRef<HTMLInputElement>(null)
  const imageProcessor = meeting.agents.find(
    (agent) => meeting.agentRoles[agent.id] === 'image_processor',
  )
  const imageAnalyser = meeting.agents.find(
    (agent) => meeting.agentRoles[agent.id] === 'image_analyser',
  )
  const advisorAgents = meeting.agents.filter(
    (agent) => meeting.agentRoles[agent.id] === 'advisor',
  )
  const mentionableAgents = meeting.agents.filter(
    (agent) =>
      meeting.agentRoles[agent.id] !== 'director' &&
      meeting.agentRoles[agent.id] !== 'image_processor',
  )
  const advisorCount = advisorAgents.length
  const activeMention = getActiveMention(chatDraft, chatCaretPosition)
  const mentionSuggestions =
    activeMention &&
    !dismissMentionSuggestions
      ? mentionableAgents
        .filter((agent) =>
          agent.name.toLocaleLowerCase().startsWith(activeMention.query.toLocaleLowerCase()),
        )
        .slice(0, 5)
      : []
  const activeMentionSuggestionIndex = Math.min(
    mentionSuggestionIndex,
    mentionSuggestions.length - 1,
  )
  const hasDirector = meeting.agents.some(
    (agent) => meeting.agentRoles[agent.id] === 'director',
  )
  const missingProviders = useMemo(
    () => [
      ...new Set(
        meeting.agents
          .filter(
            (agent) =>
              meeting.agentRoles[agent.id] !== 'image_processor' &&
              !providers?.[agent.provider],
          )
          .map((agent) => agent.provider),
      ),
    ],
    [meeting.agents, meeting.agentRoles, providers],
  )
  const missingReportProviders = useMemo(
    () => [
      ...new Set(
        meeting.agents
          .filter(
            (agent) =>
              (meeting.agentRoles[agent.id] === 'advisor' ||
                meeting.agentRoles[agent.id] === 'report_formatter') &&
              !providers?.[agent.provider],
          )
          .map((agent) => agent.provider),
      ),
    ],
    [meeting.agents, meeting.agentRoles, providers],
  )
  const reportOnlyMissingProviders = missingReportProviders.filter(
    (provider) => !missingProviders.includes(provider),
  )

  useEffect(() => {
    meetingRef.current = meeting
    onUpdateRef.current = onUpdate
  }, [meeting, onUpdate])

  useEffect(() => {
    if (meeting.status !== 'running' || isRunning) return

    const controller = new AbortController()
    let checking = false
    let inactiveChecks = 0

    async function checkRunStatus() {
      if (checking) return
      checking = true
      try {
        const response = await fetch(
          `/api/boardrooms/runs/${encodeURIComponent(meeting.id)}`,
          { signal: controller.signal },
        )
        if (!response.ok) {
          throw new Error(`Checking the boardroom response returned ${response.status}.`)
        }
        const result: unknown = await response.json()
        if (!isRecord(result) || typeof result.active !== 'boolean') {
          throw new Error('The boardroom response status was invalid.')
        }

        setRunStatusError('')
        if (result.active) {
          inactiveChecks = 0
          return
        }

        inactiveChecks += 1
        if (inactiveChecks >= 2) {
          const updated: Meeting = {
            ...meetingRef.current,
            status: 'interrupted',
            error: 'This response is no longer active. You can continue chatting.',
            updatedAt: new Date().toISOString(),
          }
          meetingRef.current = updated
          onUpdateRef.current(updated)
        }
      } catch (requestError) {
        if (controller.signal.aborted) return
        setRunStatusError(
          requestError instanceof Error
            ? requestError.message
            : 'Could not check whether this response is active.',
        )
      } finally {
        checking = false
      }
    }

    void checkRunStatus()
    const interval = window.setInterval(() => void checkRunStatus(), 3_000)
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [isRunning, meeting.id, meeting.status])

  useEffect(() => {
    if (meeting.mode === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [meeting.chatMessages.length, meeting.mode, meeting.reports.length, statusMessage])

  useEffect(
    () => () => {
      controllerRef.current?.abort()
      reportControllerRef.current?.abort()
      imageControllerRef.current?.abort()
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
            ? 'The boardroom is considering your message…'
            : `Round ${event.round} of ${event.totalRounds}`,
        )
        break
      case 'route_start':
        setStatusMessage(`${event.agentName} is selecting the best-fit roles…`)
        break
      case 'route_complete':
        setStatusMessage(`${event.agentName} was selected to respond…`)
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
                ...(event.turn.imageUrl ? { imageUrl: event.turn.imageUrl } : {}),
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
        setStatusMessage(
          meetingRef.current.mode === 'chat' ? 'Response complete' : 'Discussion complete',
        )
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
          meetingId: meeting.id,
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

  function selectAgentMention(agent: Meeting['agents'][number]) {
    if (!activeMention) return
    const mentionText = `@{${agent.name}} `
    const updatedDraft =
      chatDraft.slice(0, activeMention.start) +
      mentionText +
      chatDraft.slice(activeMention.end)
    const caret = activeMention.start + mentionText.length
    setChatDraft(updatedDraft)
    setChatCaretPosition(caret)
    setDismissMentionSuggestions(false)
    window.requestAnimationFrame(() => {
      chatInputRef.current?.focus()
      chatInputRef.current?.setSelectionRange(caret, caret)
    })
  }

  async function sendChatMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const content =
      chatDraft.trim() ||
      (analysisImageFile ? 'Please analyse the attached image.' : '')
    if (
      !content ||
      isRunning ||
      meetingRef.current.status === 'running' ||
      missingProviders.length > 0
    ) {
      return
    }

    const currentMeeting = meetingRef.current
    let imageDataUrl: string | undefined
    if (analysisImageFile) {
      try {
        imageDataUrl = await readFileAsDataUrl(analysisImageFile)
      } catch (error) {
        setAnalysisImageError(
          error instanceof Error ? error.message : 'Could not read the selected image.',
        )
        return
      }
    }
    const mentionableAgents = currentMeeting.agents.filter(
      (agent) =>
        currentMeeting.agentRoles[agent.id] !== 'director' &&
        currentMeeting.agentRoles[agent.id] !== 'image_processor',
    )
    const mentionedAgent =
      !analysisImageFile ? resolveAgentMention(content, mentionableAgents) : null
    const userMessage: BoardroomChatMessage = {
      id: createId(),
      role: 'user',
      content: imageDataUrl ? `${content}\n[Image attached for analysis.]` : content,
      createdAt: new Date().toISOString(),
    }
    updateMeeting({
      chatMessages: [...currentMeeting.chatMessages, userMessage],
      status: 'running',
      synthesis: '',
      error: '',
    })
    setChatDraft('')
    setAnalysisImageFile(null)
    setAnalysisImageError('')
    if (analysisImageInputRef.current) analysisImageInputRef.current.value = ''
    const controller = new AbortController()
    controllerRef.current = controller
    setIsRunning(true)
    setStatusMessage('Preparing the boardroom…')

    let completed = false
    let failed = false
    try {
      await streamBoardroom(
        {
          meetingId: currentMeeting.id,
          task: mentionedAgent?.prompt ?? content,
          context: formatChatContext(currentMeeting, currentMeeting.chatMessages),
          ...(imageDataUrl ? { imageDataUrl } : {}),
          ...(mentionedAgent ? { directAgentId: mentionedAgent.agent.id } : {}),
          agents: currentMeeting.agents,
          rounds: 1,
          facilitatorId: currentMeeting.facilitatorId,
          synthesize: currentMeeting.chatType === 'document',
          agentRoles: currentMeeting.agentRoles,
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
      missingReportProviders.length > 0 ||
      currentMeeting.status === 'running'
    ) {
      return
    }

    const context = formatChatContext(
      currentMeeting,
      currentMeeting.chatMessages.slice(0, sourceIndex + 1),
    )
    const reportAgents = currentMeeting.agents.filter(
      (agent) =>
        currentMeeting.agentRoles[agent.id] === 'advisor' ||
        currentMeeting.agentRoles[agent.id] === 'report_formatter',
    )
    const reportAgentRoles: Record<string, ChatAgentRole> = {}
    for (const agent of reportAgents) {
      reportAgentRoles[agent.id] = currentMeeting.agentRoles[agent.id]
    }
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
          agents: reportAgents,
          agentRoles: reportAgentRoles,
          facilitatorId: currentMeeting.facilitatorId,
          formatterId: Object.entries(currentMeeting.agentRoles).find(
            ([, role]) => role === 'report_formatter',
          )?.[0],
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

  async function upscaleUploadedImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const processor = meetingRef.current.agents.find(
      (agent) => meetingRef.current.agentRoles[agent.id] === 'image_processor',
    )
    if (!imageFile || !processor || !providers?.magnific || isUpscaling) return

    setIsUpscaling(true)
    setImageProcessingError('')
    setImageProcessingStatus('Uploading image to Magnific…')
    const controller = new AbortController()
    imageControllerRef.current = controller
    try {
      const image = await readFileAsDataUrl(imageFile)
      setImageProcessingStatus('Magnific is enhancing the image…')
      const response = await fetch('/api/boardrooms/images/upscale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image,
          scaleFactor: imageScaleFactor,
          flavor: imageFlavor,
        }),
        signal: controller.signal,
      })
      const result: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const message =
          isRecord(result) && typeof result.error === 'string'
            ? result.error
            : `Image processing failed (${response.status}).`
        throw new Error(message)
      }
      if (!isRecord(result) || !isSecureImageUrl(result.imageUrl)) {
        throw new Error('Magnific returned an invalid image URL.')
      }

      const createdAt = new Date().toISOString()
      updateMeeting({
        chatMessages: [
          ...meetingRef.current.chatMessages,
          {
            id: createId(),
            role: 'user',
            content: `Upscale ${imageFile.name} (${imageScaleFactor}×)`,
            createdAt,
          },
          {
            id: createId(),
            role: 'agent',
            content: `Upscaled with Magnific (${imageScaleFactor}×).`,
            createdAt,
            agentId: processor.id,
            agentName: processor.name,
            agentRole: 'Image processor',
            imageUrl: result.imageUrl,
          },
        ],
      })
      setImageFile(null)
      if (imageInputRef.current) imageInputRef.current.value = ''
      setImageProcessingStatus('Image enhancement complete.')
    } catch (error) {
      if (controller.signal.aborted) {
        setImageProcessingStatus('Image enhancement cancelled.')
      } else {
        setImageProcessingError(
          error instanceof Error ? error.message : 'Could not upscale the image.',
        )
        setImageProcessingStatus('')
      }
    } finally {
      imageControllerRef.current = null
      setIsUpscaling(false)
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
              {meeting.mode === 'chat'
                ? meeting.chatType === 'document'
                  ? 'REPORT / DOCUMENT CHAT'
                  : 'INFORMATIONAL ADVISOR CHAT'
                : 'BOARDROOM MEETING'}
            </p>
            <h2>{meeting.name}</h2>
          </div>
          <div className="meeting-room-actions">
            <span className={`meeting-status status-${meeting.status}`}>
              {isRunning && <span className="status-dot working" />}
              {statusLabel(meeting.status, meeting.mode)}
            </span>
            {meeting.mode === 'chat' && (
              <button
                className="secondary-button"
                disabled={meeting.status === 'running'}
                onClick={onEdit}
                title={
                  meeting.status === 'running'
                    ? 'Wait for the current response to finish before editing.'
                    : undefined
                }
                type="button"
              >
                Edit chat
              </button>
            )}
          </div>
        </div>
        {meeting.task !== 'Ongoing boardroom chat' && (
          <p className="meeting-agenda">{meeting.task}</p>
        )}
        <div className="meeting-participants">
          {meeting.agents.map((agent) => (
            <span className="participant-chip" key={agent.id}>
              <span>{agent.name.trim().charAt(0).toUpperCase() || 'A'}</span>
              {agent.name} · {chatRoleLabel(meeting.agentRoles[agent.id])}
            </span>
          ))}
          <span className="meeting-rounds">
            {meeting.mode === 'chat'
              ? meeting.chatType === 'informational'
                ? hasDirector
                  ? 'Orchestrator selects 1–3 roles'
                  : 'Direct advisor replies · @name for one'
                : hasDirector
                  ? 'Orchestrator routing · team synthesis'
                  : 'Ongoing chat · team synthesis'
              : `${meeting.rounds} discussion rounds`}
          </span>
        </div>
        {missingProviders.length > 0 && (
          <div className="notice setup-notice">
            <strong>Provider access is needed for this boardroom.</strong>
            <span>
              Configure {missingProviders.map(providerLabel).join(' and ')} on the server,
              or edit the meeting’s agent selection.
            </span>
          </div>
        )}
        {error && <div className="notice error-notice" role="alert">{error}</div>}
        {meeting.mode === 'chat' && imageProcessor && !providers?.magnific && (
          <div className="notice setup-notice">
            <strong>Magnific access is needed to process images.</strong>
            <span>Configure MAGNIFIC_API_KEY on the server, then restart DiscussIt.</span>
          </div>
        )}
        {meeting.chatType === 'document' && reportOnlyMissingProviders.length > 0 && (
          <div className="notice setup-notice">
            <strong>Provider access is needed for report formatting.</strong>
            <span>
              Configure {reportOnlyMissingProviders.map(providerLabel).join(' and ')} on the server.
            </span>
          </div>
        )}
        {meeting.status === 'running' && !isRunning && (
          <div className="notice setup-notice">
            <strong>This discussion is running in another tab.</strong>
            <span>Its transcript and status will sync here automatically.</span>
          </div>
        )}
        {meeting.status === 'running' && !isRunning && runStatusError && (
          <div className="notice error-notice" role="alert">
            <strong>Could not verify the active boardroom response.</strong>
            <span>{runStatusError}</span>
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

      {meeting.mode === 'chat' && imageProcessor && (
        <form className="image-processing-tools" onSubmit={upscaleUploadedImage}>
          <div className="image-processing-heading">
            <div>
              <strong>Image processor · {imageProcessor.name}</strong>
              <span>Enhance and upscale an image with Magnific.</span>
            </div>
          </div>
          <div className="image-processing-controls">
            <label className="image-file-field">
              Image
              <input
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null
                  if (
                    file &&
                    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
                  ) {
                    setImageFile(null)
                    setImageProcessingError('Choose a PNG, JPEG, or WebP image.')
                    return
                  }
                  if (file && file.size > 7 * 1024 * 1024) {
                    setImageFile(null)
                    setImageProcessingError('Images must be no larger than 7 MB.')
                    return
                  }
                  setImageProcessingError('')
                  setImageFile(file)
                }}
                ref={imageInputRef}
                type="file"
              />
            </label>
            <label className="image-option-field">
              Scale
              <select
                onChange={(event) => setImageScaleFactor(Number(event.target.value))}
                value={imageScaleFactor}
              >
                <option value={2}>2×</option>
                <option value={4}>4×</option>
                <option value={8}>8×</option>
                <option value={16}>16×</option>
              </select>
            </label>
            <label className="image-option-field">
              Image style
              <select
                onChange={(event) => {
                  const flavor = event.target.value
                  if (
                    flavor === 'photo' ||
                    flavor === 'sublime' ||
                    flavor === 'photo_denoiser'
                  ) {
                    setImageFlavor(flavor)
                  }
                }}
                value={imageFlavor}
              >
                <option value="photo">Photo</option>
                <option value="sublime">Illustration / render</option>
                <option value="photo_denoiser">Noisy photo</option>
              </select>
            </label>
            <button
              className="primary-button"
              disabled={
                !imageFile ||
                isUpscaling ||
                isRunning ||
                !providers?.magnific
              }
              type="submit"
            >
              {isUpscaling ? 'Enhancing…' : 'Upscale image'}
            </button>
            {isUpscaling && (
              <button
                className="secondary-button"
                onClick={() => imageControllerRef.current?.abort()}
                type="button"
              >
                Cancel
              </button>
            )}
          </div>
          <p className="image-processing-note">
            Magnific processing may incur charges. Images are limited to 7 MB.
          </p>
          {imageProcessingStatus && (
            <p className="report-progress" role="status">{imageProcessingStatus}</p>
          )}
          {imageProcessingError && (
            <p className="form-error" role="alert">{imageProcessingError}</p>
          )}
        </form>
      )}

      {meeting.mode === 'chat' ? (
        <>
          {meeting.chatType === 'document' && (
            <div aria-label="Document boardroom tabs" className="document-tabs" role="tablist">
              <button
                aria-selected={documentTab === 'chat'}
                className={`document-tab${documentTab === 'chat' ? ' active' : ''}`}
                onClick={() => setDocumentTab('chat')}
                role="tab"
                type="button"
              >
                Chat
              </button>
              <button
                aria-selected={documentTab === 'report'}
                className={`document-tab${documentTab === 'report' ? ' active' : ''}`}
                onClick={() => setDocumentTab('report')}
                role="tab"
                type="button"
              >
                Report preview
                {meeting.reports.length > 0 && (
                  <span className="tab-count">{meeting.reports.length}</span>
                )}
              </button>
            </div>
          )}
          {meeting.chatType === 'document' && documentTab === 'report' ? (
            <div aria-label="Report preview" className="report-preview" role="tabpanel">
              {meeting.reports.length === 0 ? (
                <div className="chat-empty">
                  <span className="empty-state-icon" aria-hidden="true">✳</span>
                  <h3>No report yet.</h3>
                  <p>
                    Continue the boardroom chat, then choose Generate report beneath a
                    facilitator conclusion. Reports are generated only when you request one.
                  </p>
                </div>
              ) : (
                [...meeting.reports].reverse().map((report) => (
                  <article className="report-preview-document" key={report.id}>
                    <header>
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
                    </header>
                    <div className="report-preview-content">
                      {renderReportMarkdown(report.content)}
                    </div>
                  </article>
                ))
              )}
              {reportDownloadError && (
                <p className="form-error" role="alert">{reportDownloadError}</p>
              )}
            </div>
          ) : (
          <>
          <div aria-label="Boardroom conversation" className="chat-thread" role="tabpanel">
            {meeting.chatMessages.length === 0 ? (
              <div className="chat-empty">
                <span className="empty-state-icon" aria-hidden="true">✳</span>
                <h3>Your boardroom is ready.</h3>
                <p>
                  {meeting.chatType === 'informational'
                    ? 'Send a message to get direct responses from the advisors, without a facilitator summary.'
                    : 'Send a message to get perspectives from your advisors and a facilitator summary.'}
                </p>
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
                    {message.imageUrl && (
                      <a
                        className="chat-image-link"
                        href={message.imageUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <img
                          alt={`Image result from ${message.agentName ?? 'the image processor'}`}
                          className="chat-image-result"
                          loading="lazy"
                          src={message.imageUrl}
                        />
                      </a>
                    )}
                    {message.role === 'facilitator' && (
                      <button
                        className="text-button chat-report-button"
                        disabled={
                          isRunning ||
                          isGeneratingReport ||
                          meeting.status === 'running' ||
                          missingReportProviders.length > 0
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
            {imageAnalyser && (
              <label className="image-attachment-control">
                Attach an image for {imageAnalyser.name} to analyse
                <input
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null
                    if (
                      file &&
                      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
                    ) {
                      setAnalysisImageFile(null)
                      setAnalysisImageError('Choose a PNG, JPEG, or WebP image.')
                      return
                    }
                    if (file && file.size > 7 * 1024 * 1024) {
                      setAnalysisImageFile(null)
                      setAnalysisImageError('Images for analysis must be no larger than 7 MB.')
                      return
                    }
                    setAnalysisImageFile(file)
                    setAnalysisImageError('')
                  }}
                  ref={analysisImageInputRef}
                  type="file"
                />
              </label>
            )}
            {analysisImageFile && (
              <span className="image-attachment-name">{analysisImageFile.name}</span>
            )}
            {analysisImageError && (
              <p className="form-error" role="alert">{analysisImageError}</p>
            )}
            <div className="chat-input-wrap">
              <textarea
                aria-activedescendant={
                  mentionSuggestions.length > 0
                    ? `advisor-mention-option-${activeMentionSuggestionIndex}`
                    : undefined
                }
                aria-autocomplete="list"
                aria-controls={
                  mentionSuggestions.length > 0
                    ? 'advisor-mention-suggestions'
                    : undefined
                }
                aria-expanded={mentionSuggestions.length > 0}
                id="boardroom-chat-message"
                maxLength={4_000}
                onChange={(event) => {
                  setChatDraft(event.target.value)
                  setChatCaretPosition(event.target.selectionStart)
                  setDismissMentionSuggestions(false)
                  setMentionSuggestionIndex(0)
                }}
                onKeyDown={(event) => {
                  if (mentionSuggestions.length === 0) return
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setMentionSuggestionIndex((index) =>
                      Math.min(index + 1, mentionSuggestions.length - 1),
                    )
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setMentionSuggestionIndex((index) => Math.max(index - 1, 0))
                  } else if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    selectAgentMention(
                      mentionSuggestions[activeMentionSuggestionIndex],
                    )
                  } else if (event.key === 'Escape') {
                    setDismissMentionSuggestions(true)
                  }
                }}
                onSelect={(event) => {
                  setChatCaretPosition(event.currentTarget.selectionStart)
                  setDismissMentionSuggestions(false)
                }}
                placeholder={
                  mentionableAgents[0]
                    ? `Ask a question, or start with @{${mentionableAgents[0].name}} to address one agent…`
                    : 'Ask a question or share a follow-up…'
                }
                ref={chatInputRef}
                rows={3}
                value={chatDraft}
              />
              {mentionSuggestions.length > 0 && (
                <div
                  aria-label="Advisor suggestions"
                  className="chat-mention-suggestions"
                  id="advisor-mention-suggestions"
                  role="listbox"
                >
                  {mentionSuggestions.map((agent, index) => (
                    <button
                      aria-selected={index === activeMentionSuggestionIndex}
                      className="chat-mention-option"
                      id={`advisor-mention-option-${index}`}
                      key={agent.id}
                      onClick={() => selectAgentMention(agent)}
                      onMouseDown={(event) => event.preventDefault()}
                      role="option"
                      type="button"
                    >
                      <strong>{agent.name}</strong>
                      <span>{agent.role} · {chatRoleLabel(meeting.agentRoles[agent.id])}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="chat-composer-footer">
              <span>
                {meeting.chatType === 'informational'
                  ? hasDirector
                    ? 'The Orchestrator selects 1–3 roles for each prompt. Start with @{agent name} to direct a response.'
                    : 'Agents respond directly. Start with @{agent name} to address one agent.'
                  : hasDirector
                    ? 'The Orchestrator selects up to three roles, then the team synthesizes. Start with @{agent name} to direct a response.'
                    : `Each message triggers ${advisorCount} advisor${advisorCount === 1 ? '' : 's'} and a facilitator response. Start with @{agent name} to direct a response.`}
              </span>
              {isRunning ? (
                <button className="secondary-button" onClick={stopDiscussion} type="button">
                  Stop response
                </button>
              ) : (
                <button
                  className="primary-button"
                  disabled={
                    (!chatDraft.trim() && !analysisImageFile) ||
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
          )}
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
