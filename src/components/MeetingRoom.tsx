import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react'
import type {
  BoardroomChatAttachment,
  BoardroomChatMessage,
  BoardroomEvent,
  BoardroomReport,
  BoardroomReportEvent,
  BoardroomReportType,
  BoardroomTurn,
  Meeting,
  MeetingMode,
  MeetingStatus,
  ProviderAvailability,
} from '../../shared/boardroom'
import {
  isBoardroomChatAttachment,
  MAX_BOARDROOM_CHAT_ATTACHMENT_BYTES,
  MAX_BOARDROOM_CHAT_ATTACHMENT_CONTEXT_LENGTH,
  MAX_BOARDROOM_CHAT_ATTACHMENTS,
} from '../../shared/boardroom'
import {
  isDecisionRoutingAgent,
  isTextGenerationAgent,
  isBoardroomImageSource,
  modelCapabilityLabels,
  resolveAgentMention,
} from '../../shared/chat'
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
const CHAT_ATTACHMENT_EXTENSIONS = new Set([
  'csv',
  'docx',
  'md',
  'markdown',
  'pdf',
  'pptx',
  'txt',
  'xlsx',
])
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

function renderMarkdownInline(text: string): ReactNode[] {
  return text
    .split(/(\[[^\]]+\]\(https:\/\/[^)\s]+\)|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_)/g)
    .map((part, index) => {
      const link = /^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/.exec(part)
      if (link) {
        return (
          <a href={link[2]} key={index} rel="noreferrer" target="_blank">
            {link[1]}
          </a>
        )
      }
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

function renderChatMarkdown(content: string): ReactNode[] {
  const segments = content.split(/(```[\s\S]*?```)/g)
  const nodes: ReactNode[] = []

  segments.forEach((segment, segmentIndex) => {
    if (!segment) return
    if (segment.startsWith('```') && segment.endsWith('```')) {
      const inner = segment.slice(3, -3).replace(/^[a-zA-Z0-9_-]+\r?\n/, '')
      nodes.push(
        <pre className="chat-code-block" key={`code-${segmentIndex}`}>
          <code>{inner.trimEnd()}</code>
        </pre>,
      )
      return
    }

    const lines = segment.split(/\r?\n/)
    let index = 0
    while (index < lines.length) {
      const line = lines[index].trim()
      if (!line) {
        index += 1
        continue
      }

      const heading = /^(#{1,6})\s+(.+)$/.exec(line)
      if (heading) {
        const level = Math.min(heading[1].length + 2, 6)
        const Heading = `h${level}` as 'h3' | 'h4' | 'h5' | 'h6'
        nodes.push(
          createElement(
            Heading,
            { className: 'chat-md-heading', key: `h-${segmentIndex}-${index}` },
            renderMarkdownInline(heading[2]),
          ),
        )
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
        nodes.push(
          <div className="report-preview-table-wrap" key={`tbl-${segmentIndex}-${index}`}>
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

      if (/^[-*+]\s+(.+)$/.test(line)) {
        const items: string[] = []
        while (index < lines.length) {
          const item = /^[-*+]\s+(.+)$/.exec(lines[index].trim())
          if (!item) break
          items.push(item[1])
          index += 1
        }
        nodes.push(
          <ul className="chat-md-list" key={`ul-${segmentIndex}-${index}`}>
            {items.map((item, itemIndex) => (
              <li key={itemIndex}>{renderMarkdownInline(item)}</li>
            ))}
          </ul>,
        )
        continue
      }

      if (/^\d+\.\s+(.+)$/.test(line)) {
        const items: string[] = []
        while (index < lines.length) {
          const item = /^\d+\.\s+(.+)$/.exec(lines[index].trim())
          if (!item) break
          items.push(item[1])
          index += 1
        }
        nodes.push(
          <ol className="chat-md-list" key={`ol-${segmentIndex}-${index}`}>
            {items.map((item, itemIndex) => (
              <li key={itemIndex}>{renderMarkdownInline(item)}</li>
            ))}
          </ol>,
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
        !/^\d+\.\s+/.test(lines[index].trim()) &&
        !startsMarkdownTable(lines, index)
      ) {
        paragraph.push(lines[index].trim())
        index += 1
      }
      nodes.push(
        <p className="chat-md-paragraph" key={`p-${segmentIndex}-${index}`}>
          {renderMarkdownInline(paragraph.join(' '))}
        </p>,
      )
    }
  })

  return nodes
}

function displayChatContent(message: BoardroomChatMessage): string {
  if (message.role === 'user' && message.imageUrl) {
    return message.content.replace(/\n\[Image attached\.\]$/, '')
  }
  return message.content
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
  latestAttachments: BoardroomChatAttachment[] = [],
): string {
  const boardroomContext =
    meeting.task && meeting.task !== 'Ongoing boardroom chat'
      ? `Boardroom context:\n${meeting.task}\n\n`
      : ''
  const memoryPrefix = meeting.chatMemory
    ? `Persistent chat memory:\n${meeting.chatMemory.summary}\n\n`
    : ''
  const entries = messages
    .slice(meeting.chatMemory?.throughMessageCount ?? 0)
    .map((message) => {
      const speaker =
        message.role === 'user'
          ? 'User'
          : message.role === 'facilitator'
            ? `${message.agentName ?? 'Facilitator'} — synthesis`
            : `${message.agentName ?? 'Advisor'}${message.agentRole ? ` (${message.agentRole})` : ''}`
      const attachmentText = message.attachments
        ?.map(
          (attachment) =>
            `[Untrusted attachment: ${attachment.name}]\n${attachment.extractedText}`,
        )
        .join('\n\n')
      return `${speaker}:\n${message.content}${attachmentText ? `\n\n${attachmentText}` : ''}`
    })

  const attachmentHeaders = latestAttachments.map(
    (attachment) => `[Untrusted attachment: ${attachment.name}]\n`,
  )
  const textBudget = Math.max(
    0,
    Math.floor(
      (MAX_BOARDROOM_CHAT_ATTACHMENT_CONTEXT_LENGTH -
        attachmentHeaders.reduce((total, header) => total + header.length, 0)) /
        Math.max(latestAttachments.length, 1),
    ) - 48,
  )
  const currentAttachmentsContext = latestAttachments
    .map((attachment, index) => {
      const text = attachment.extractedText.slice(0, textBudget)
      const truncated =
        attachment.extractedText.length > text.length
          ? '\n[Attachment text truncated for model context.]'
          : ''
      return `${attachmentHeaders[index]}${text}${truncated}`
    })
    .join('\n\n')
  const historicalContextLimit =
    CHAT_CONTEXT_LIMIT -
    (currentAttachmentsContext ? currentAttachmentsContext.length + 2 : 0)

  let context = ''
  for (let firstEntry = 0; firstEntry <= entries.length; firstEntry += 1) {
    const omitted = firstEntry > 0 ? 'Earlier messages omitted for context length.\n\n' : ''
    context = `${boardroomContext}${memoryPrefix}${omitted}Recent conversation:\n${entries.slice(firstEntry).join('\n\n')}`
    if (context.length <= historicalContextLimit || firstEntry >= entries.length) break
  }

  const combinedContext = currentAttachmentsContext
    ? `${context.slice(-historicalContextLimit)}\n\n${currentAttachmentsContext}`
    : context
  return combinedContext.slice(-CHAT_CONTEXT_LIMIT)
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
    case 'gemini':
      return 'Gemini'
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
  const [chatMemoryWarning, setChatMemoryWarning] = useState('')
  const [chatDraft, setChatDraft] = useState('')
  const [chatImageFile, setChatImageFile] = useState<File | null>(null)
  const [chatAttachmentFiles, setChatAttachmentFiles] = useState<File[]>([])
  const [chatAttachmentError, setChatAttachmentError] = useState('')
  const [liveTurn, setLiveTurn] = useState<
    (BoardroomTurn & { createdAt: string }) | null
  >(null)
  const [liveSynthesis, setLiveSynthesis] = useState<{
    messageId: string
    agentId: string
    agentName: string
    createdAt: string
    content: string
  } | null>(null)
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
  const [isChatDescriptionExpanded, setIsChatDescriptionExpanded] = useState(false)
  const [showImagesDrawer, setShowImagesDrawer] = useState(false)
  const [showUpscaler, setShowUpscaler] = useState(false)
  const [isDraggingAttachment, setIsDraggingAttachment] = useState(false)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const error = meeting.error
  const controllerRef = useRef<AbortController | null>(null)
  const reportControllerRef = useRef<AbortController | null>(null)
  const imageControllerRef = useRef<AbortController | null>(null)
  const meetingRef = useRef(meeting)
  const onUpdateRef = useRef(onUpdate)
  const chatThreadRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const chatImageInputRef = useRef<HTMLInputElement>(null)
  const chatFileInputRef = useRef<HTMLInputElement>(null)
  const imageProcessor = meeting.agents.find(
    (agent) =>
      agent.provider === 'magnific' &&
      agent.modelCapabilities?.supportsImageProcessing === true,
  )
  const advisorAgents = meeting.agents.filter(
    (agent) =>
      meeting.agentRoles[agent.id] !== 'director' &&
      !isDecisionRoutingAgent(agent) &&
      !(
        agent.provider === 'magnific' &&
        agent.modelCapabilities?.supportsImageProcessing &&
        !agent.modelCapabilities.supportsImageGeneration
      ),
  )
  const mentionableAgents = meeting.agents.filter(
    (agent) =>
      meeting.agentRoles[agent.id] !== 'director' &&
      !isDecisionRoutingAgent(agent) &&
      !(
        agent.provider === 'magnific' &&
        agent.modelCapabilities?.supportsImageProcessing &&
        !agent.modelCapabilities.supportsImageGeneration
      ),
  )
  const advisorCount = advisorAgents.length
  const streamedChatMessages: BoardroomChatMessage[] = [
    ...(liveTurn
      ? [{
          id: liveTurn.id,
          role: 'agent' as const,
          content: liveTurn.content,
          createdAt: liveTurn.createdAt,
          agentId: liveTurn.agentId,
          agentName: liveTurn.agentName,
          agentRole: liveTurn.agentRole,
        }]
      : []),
    ...(liveSynthesis
      ? [{
          id: liveSynthesis.messageId,
          role: 'facilitator' as const,
          content: liveSynthesis.content,
          createdAt: liveSynthesis.createdAt,
          agentId: liveSynthesis.agentId,
          agentName: liveSynthesis.agentName,
        }]
      : []),
  ].filter((message) => message.content.length > 0)
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
              !(
                agent.provider === 'magnific' &&
                agent.modelCapabilities?.supportsImageProcessing &&
                !agent.modelCapabilities.supportsImageGeneration
              ) &&
              !providers?.[agent.provider],
          )
          .map((agent) => agent.provider),
      ),
    ],
    [meeting.agents, providers],
  )
  const missingReportProviders = useMemo(
    () => [
      ...new Set(
        meeting.agents
          .filter(
            (agent) =>
              !(
                agent.provider === 'magnific' &&
                agent.modelCapabilities?.supportsImageProcessing &&
                !agent.modelCapabilities.supportsImageGeneration
              ) &&
              !providers?.[agent.provider],
          )
          .map((agent) => agent.provider),
      ),
    ],
    [meeting.agents, providers],
  )
  const reportOnlyMissingProviders = missingReportProviders.filter(
    (provider) => !missingProviders.includes(provider),
  )
  const storedImages = useMemo(
    () =>
      meeting.chatMessages
        .filter((message): message is BoardroomChatMessage & { imageUrl: string } =>
          Boolean(message.imageUrl),
        )
        .map((message) => ({
          id: message.id,
          imageUrl: message.imageUrl,
          label:
            message.role === 'user'
              ? 'Attached'
              : message.agentName ?? 'Generated',
          createdAt: message.createdAt,
        })),
    [meeting.chatMessages],
  )
  const chatImagePreviewUrl = useMemo(
    () => (chatImageFile ? URL.createObjectURL(chatImageFile) : null),
    [chatImageFile],
  )

  useEffect(() => {
    return () => {
      if (chatImagePreviewUrl) URL.revokeObjectURL(chatImagePreviewUrl)
    }
  }, [chatImagePreviewUrl])

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
      const chatThread = chatThreadRef.current
      chatThread?.scrollTo({
        top: chatThread.scrollHeight,
        behavior:
          liveTurn?.content || liveSynthesis?.content ? 'auto' : 'smooth',
      })
    }
  }, [
    liveSynthesis?.content,
    liveTurn?.content,
    meeting.chatMessages.length,
    meeting.mode,
    meeting.reports.length,
    statusMessage,
  ])

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
        setLiveTurn(null)
        setStatusMessage(
          meetingRef.current.mode === 'chat'
            ? `${event.agentName} is thinking…`
            : `Round ${event.round}: ${event.agentName} is thinking…`,
        )
        break
      case 'turn_delta':
        setLiveTurn((current) => ({
          id: event.turnId,
          agentId: event.agentId,
          agentName: event.agentName,
          agentRole: event.agentRole,
          round: event.round,
          createdAt:
            current?.id === event.turnId
              ? current.createdAt
              : new Date().toISOString(),
          content:
            current?.id === event.turnId
              ? current.content + event.delta
              : event.delta,
        }))
        break
      case 'turn_complete':
        setLiveTurn((current) =>
          current?.id === event.turn.id ? null : current,
        )
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
        setLiveSynthesis({
          messageId: event.messageId,
          agentId: event.agentId,
          agentName: event.agentName,
          createdAt: new Date().toISOString(),
          content: '',
        })
        setStatusMessage(`${event.agentName} is preparing the synthesis…`)
        break
      case 'synthesis_delta':
        setLiveSynthesis((current) =>
          current?.messageId === event.messageId
            ? { ...current, content: current.content + event.delta }
            : current,
        )
        break
      case 'synthesis_complete':
        setLiveSynthesis((current) =>
          current?.messageId === event.messageId ? null : current,
        )
        if (meetingRef.current.mode === 'chat') {
          updateMeeting({
            synthesis: event.content,
            chatMessages: meetingRef.current.chatMessages.some(
              (message) => message.id === event.messageId,
            )
              ? meetingRef.current.chatMessages.map((message) =>
                  message.id === event.messageId
                    ? { ...message, content: event.content }
                    : message,
                )
              : [
                  ...meetingRef.current.chatMessages,
                  {
                    id: event.messageId,
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
      case 'chat_memory_start':
        setStatusMessage('Compacting chat memory…')
        break
      case 'chat_memory_update':
        updateMeeting({
          chatMemory: {
            summary: event.summary,
            throughMessageCount: meetingRef.current.chatMessages.length,
          },
        })
        setChatMemoryWarning('')
        break
      case 'chat_memory_error':
        setChatMemoryWarning(event.message)
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
    setLiveTurn(null)
    setLiveSynthesis(null)
    setIsRunning(true)
    setChatMemoryWarning('')
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

  function selectChatImage(file: File | null) {
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setChatImageFile(null)
      setChatAttachmentError('Choose a PNG, JPEG, or WebP image.')
      if (chatImageInputRef.current) chatImageInputRef.current.value = ''
      return
    }
    if (file.size > 7 * 1024 * 1024) {
      setChatImageFile(null)
      setChatAttachmentError('Images must be no larger than 7 MB.')
      if (chatImageInputRef.current) chatImageInputRef.current.value = ''
      return
    }
    setChatImageFile(file)
    setChatAttachmentError('')
  }

  function selectChatAttachments(files: File[]) {
    if (files.length === 0) return
    const unsupported = files.find((file) => {
      const extension = file.name.split('.').at(-1)?.toLowerCase()
      return !extension || !CHAT_ATTACHMENT_EXTENSIONS.has(extension)
    })
    if (unsupported) {
      setChatAttachmentError(
        'Choose PDF, DOCX, TXT, Markdown, CSV, XLSX, or PPTX files.',
      )
      return
    }
    if (files.some((file) => file.size === 0)) {
      setChatAttachmentError('Empty files cannot be attached.')
      return
    }
    if (files.some((file) => file.size > MAX_BOARDROOM_CHAT_ATTACHMENT_BYTES)) {
      setChatAttachmentError('Files must be no larger than 10 MB each.')
      return
    }
    if (chatAttachmentFiles.length + files.length > MAX_BOARDROOM_CHAT_ATTACHMENTS) {
      setChatAttachmentError('Attach up to 3 documents per message.')
      return
    }
    setChatAttachmentFiles((current) => [...current, ...files])
    setChatAttachmentError('')
  }

  function pasteChatImage(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length === 0) return
    event.preventDefault()
    const image = files.find((file) => file.type.startsWith('image/'))
    if (image) {
      const fileName =
        image.name || `pasted-image.${image.type.split('/')[1] || 'png'}`
      selectChatImage(
        image.name ? image : new File([image], fileName, { type: image.type }),
      )
    }
    const documents = files.filter((file) => !file.type.startsWith('image/'))
    if (documents.length > 0) selectChatAttachments(documents)
  }

  function handleChatDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDraggingAttachment(false)
    const files = Array.from(event.dataTransfer.files)
    const image = files.find((file) => file.type.startsWith('image/'))
    if (image) selectChatImage(image)
    const documents = files.filter((file) => !file.type.startsWith('image/'))
    if (documents.length > 0) selectChatAttachments(documents)
    if (!image && documents.length === 0) {
      setChatAttachmentError('Choose supported documents or a PNG, JPEG, or WebP image.')
    }
  }

  async function fetchImageAsFile(imageUrl: string, baseName: string): Promise<File> {
    const response = await fetch(imageUrl)
    if (!response.ok) {
      throw new Error('Could not load the selected image.')
    }
    const blob = await response.blob()
    const mime = ['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)
      ? blob.type
      : 'image/png'
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]
    const safeName = baseName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32) || 'image'
    return new File([blob], `${safeName}.${ext}`, { type: mime })
  }

  async function reuseImageInChat(imageUrl: string, label: string) {
    try {
      const file = await fetchImageAsFile(imageUrl, label)
      selectChatImage(file)
      setShowImagesDrawer(false)
      setDocumentTab('chat')
      chatInputRef.current?.focus()
    } catch (error) {
      setChatAttachmentError(
        error instanceof Error ? error.message : 'Could not attach the selected image.',
      )
    }
  }

  async function loadImageIntoUpscaler(imageUrl: string, label: string) {
    try {
      const file = await fetchImageAsFile(imageUrl, label)
      setImageFile(file)
      setImageProcessingError('')
      setShowUpscaler(true)
      setShowImagesDrawer(false)
    } catch (error) {
      setImageProcessingError(
        error instanceof Error ? error.message : 'Could not load the image for upscaling.',
      )
      setShowUpscaler(true)
    }
  }

  function copyMessageContent(messageId: string, text: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedMessageId(messageId)
      window.setTimeout(() => {
        setCopiedMessageId((current) => (current === messageId ? null : current))
      }, 1500)
    })
  }

  function insertMentionTrigger() {
    const textarea = chatInputRef.current
    const cursor = textarea ? textarea.selectionStart : chatDraft.length
    const prefix = chatDraft.slice(0, cursor)
    const needsSpace = prefix.length > 0 && !/\s$/.test(prefix)
    const insertion = needsSpace ? ' @' : '@'
    const nextDraft = `${prefix}${insertion}${chatDraft.slice(cursor)}`
    const nextCursor = cursor + insertion.length
    setChatDraft(nextDraft)
    setChatCaretPosition(nextCursor)
    setDismissMentionSuggestions(false)
    setMentionSuggestionIndex(0)
    requestAnimationFrame(() => {
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(nextCursor, nextCursor)
    })
  }

  async function sendChatMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const hasAttachments = Boolean(chatImageFile || chatAttachmentFiles.length > 0)
    const content =
      chatDraft.trim() ||
      (chatImageFile && chatAttachmentFiles.length > 0
        ? 'Please review the attached image and files.'
        : chatImageFile
          ? 'Please review the attached image.'
          : chatAttachmentFiles.length > 0
            ? 'Please review the attached files.'
            : '')
    if (
      !content ||
      isRunning ||
      meetingRef.current.status === 'running' ||
      missingProviders.length > 0
    ) {
      return
    }

    const currentMeeting = meetingRef.current
    setLiveTurn(null)
    setLiveSynthesis(null)
    const mentionableAgents = currentMeeting.agents.filter(
      (agent) =>
        currentMeeting.agentRoles[agent.id] !== 'director' &&
        !isDecisionRoutingAgent(agent) &&
        !(
          agent.provider === 'magnific' &&
          agent.modelCapabilities?.supportsImageProcessing &&
          !agent.modelCapabilities.supportsImageGeneration
        ),
    )
    const mentionedAgent = resolveAgentMention(content, mentionableAgents)
    const supportsChatImageInput = (agent: Meeting['agents'][number]) =>
      isTextGenerationAgent(agent) &&
      agent.modelCapabilities?.supportsVision === true &&
      currentMeeting.agentRoles[agent.id] !== 'director'
    if (
      chatImageFile &&
      !currentMeeting.agents.some(supportsChatImageInput)
    ) {
      setChatAttachmentError(
        'Add an agent whose model supports image input to use attachments in chat.',
      )
      return
    }
    if (
      chatImageFile &&
      mentionedAgent &&
      !supportsChatImageInput(mentionedAgent.agent)
    ) {
      setChatAttachmentError(
        `${mentionedAgent.agent.name} cannot inspect attached images. Mention a vision-capable agent or remove the attachment.`,
      )
      return
    }

    let imageDataUrl: string | undefined
    let imageUrl: string | undefined
    const uploadedAttachments: BoardroomChatAttachment[] = []
    const controller = new AbortController()
    controllerRef.current = controller
    setIsRunning(true)
    setChatMemoryWarning('')
    setStatusMessage(hasAttachments ? 'Uploading attachments…' : 'Preparing the boardroom…')
    try {
      if (chatImageFile) {
        imageDataUrl = await readFileAsDataUrl(chatImageFile)
        const response = await fetch('/api/boardrooms/images/uploads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageDataUrl }),
          signal: controller.signal,
        })
        const result: unknown = await response.json().catch(() => null)
        if (!response.ok) {
          const message =
            isRecord(result) && typeof result.error === 'string'
              ? result.error
              : `Image upload failed (${response.status}).`
          throw new Error(message)
        }
        if (!isRecord(result) || !isBoardroomImageSource(result.imageUrl)) {
          throw new Error('The server returned an invalid image attachment URL.')
        }
        imageUrl = result.imageUrl
      }

      for (const file of chatAttachmentFiles) {
        const response = await fetch('/api/boardrooms/files/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name),
          },
          body: file,
          signal: controller.signal,
        })
        const result: unknown = await response.json().catch(() => null)
        if (!response.ok) {
          const message =
            isRecord(result) && typeof result.error === 'string'
              ? result.error
              : `File upload failed (${response.status}).`
          throw new Error(message)
        }
        if (
          !isRecord(result) ||
          !isBoardroomChatAttachment(result.attachment)
        ) {
          throw new Error('The server returned invalid file attachment details.')
        }
        uploadedAttachments.push(result.attachment)
      }
    } catch (error) {
      if (controller.signal.aborted) {
        setStatusMessage('Attachment upload cancelled.')
      } else {
        setChatAttachmentError(
          error instanceof Error ? error.message : 'Could not upload the attachments.',
        )
        setStatusMessage('')
      }
      controllerRef.current = null
      setIsRunning(false)
      return
    }

    const userMessage: BoardroomChatMessage = {
      id: createId(),
      role: 'user',
      content: imageDataUrl ? `${content}\n[Image attached.]` : content,
      createdAt: new Date().toISOString(),
      ...(imageUrl ? { imageUrl } : {}),
      ...(uploadedAttachments.length > 0
        ? { attachments: uploadedAttachments }
        : {}),
    }
    updateMeeting({
      chatMessages: [...currentMeeting.chatMessages, userMessage],
      status: 'running',
      synthesis: '',
      error: '',
    })
    setChatDraft('')
    setChatImageFile(null)
    setChatAttachmentFiles([])
    setChatAttachmentError('')
    if (chatImageInputRef.current) chatImageInputRef.current.value = ''
    if (chatFileInputRef.current) chatFileInputRef.current.value = ''
    setStatusMessage('Preparing the boardroom…')

    let completed = false
    let failed = false
    try {
      await streamBoardroom(
        {
          meetingId: currentMeeting.id,
          task: mentionedAgent?.prompt ?? content,
          context: formatChatContext(
            currentMeeting,
            currentMeeting.chatMessages,
            uploadedAttachments,
          ),
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
          agentRoles: currentMeeting.agentRoles,
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

  async function upscaleUploadedImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const processor = meetingRef.current.agents.find(
      (agent) =>
        agent.provider === 'magnific' &&
        agent.modelCapabilities?.supportsImageProcessing === true,
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
      if (!isRecord(result) || !isBoardroomImageSource(result.imageUrl)) {
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
              <>
                <button
                  aria-expanded={showImagesDrawer}
                  className={`secondary-button${showImagesDrawer ? ' active-toggle' : ''}`}
                  onClick={() => setShowImagesDrawer((open) => !open)}
                  type="button"
                >
                  Images ({storedImages.length})
                </button>
                {imageProcessor && (
                  <button
                    aria-expanded={showUpscaler || isUpscaling}
                    className={`secondary-button${showUpscaler || isUpscaling ? ' active-toggle' : ''}`}
                    onClick={() => setShowUpscaler((open) => !open)}
                    type="button"
                  >
                    Upscaler
                  </button>
                )}
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
              </>
            )}
          </div>
        </div>
        {meeting.task !== 'Ongoing boardroom chat' &&
          (meeting.mode === 'chat' ? (
            <button
              aria-controls="chat-description-panel"
              aria-expanded={isChatDescriptionExpanded}
              className="meeting-agenda-toggle"
              onClick={() => setIsChatDescriptionExpanded((expanded) => !expanded)}
              type="button"
            >
              <span className="meeting-agenda-preview">{meeting.task}</span>
              <span className="meeting-agenda-toggle-label">
                {isChatDescriptionExpanded ? 'Hide description' : 'Show description'}
              </span>
            </button>
          ) : (
            <p className="meeting-agenda">{meeting.task}</p>
          ))}
        <div className="meeting-participants">
          {meeting.agents.map((agent) => (
            <span className="participant-chip" key={agent.id}>
              <span>{agent.name.trim().charAt(0).toUpperCase() || 'A'}</span>
              <span className="participant-chip-label">
                {agent.name} · {meeting.agentRoles[agent.id] === 'director'
                  ? 'Orchestrator'
                  : modelCapabilityLabels(agent.modelCapabilities).join(', ') || 'Text'}
              </span>
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

      {meeting.mode === 'chat' && imageProcessor && (showUpscaler || isUpscaling) && (
        <form className="image-processing-tools" onSubmit={upscaleUploadedImage}>
          <div className="image-processing-heading">
            <div>
              <strong>Image processor · {imageProcessor.name}</strong>
              <span>Enhance and upscale an image with Magnific.</span>
            </div>
            {!isUpscaling && (
              <button
                className="text-button"
                onClick={() => setShowUpscaler(false)}
                type="button"
              >
                Hide
              </button>
            )}
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

      {meeting.mode === 'chat' && showImagesDrawer && (
        <section aria-label="Stored chat images" className="chat-images-drawer">
          <div className="chat-images-drawer-header">
            <div>
              <strong>Stored images ({storedImages.length})</strong>
              <span>Images attached or generated in this chat are saved on the server.</span>
            </div>
            <button
              className="text-button"
              onClick={() => setShowImagesDrawer(false)}
              type="button"
            >
              Close
            </button>
          </div>
          {storedImages.length === 0 ? (
            <p className="chat-images-empty">
              No images have been attached or generated in this chat yet.
            </p>
          ) : (
            <div className="chat-images-grid">
              {[...storedImages].reverse().map((item) => (
                <div className="chat-image-card" key={item.id}>
                  <a href={item.imageUrl} rel="noreferrer" target="_blank">
                    <img alt={item.label} loading="lazy" src={item.imageUrl} />
                  </a>
                  <div className="chat-image-card-meta">
                    <span>{item.label}</span>
                    <div className="chat-image-card-actions">
                      <button
                        className="text-button"
                        onClick={() => void reuseImageInChat(item.imageUrl, item.label)}
                        type="button"
                      >
                        Use in chat
                      </button>
                      {imageProcessor && (
                        <button
                          className="text-button"
                          onClick={() => void loadImageIntoUpscaler(item.imageUrl, item.label)}
                          type="button"
                        >
                          Upscale
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
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
          <div
            className={`chat-panel${isDraggingAttachment ? ' is-dragging' : ''}`}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setIsDraggingAttachment(false)
              }
            }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes('Files')) {
                event.preventDefault()
                setIsDraggingAttachment(true)
              }
            }}
            onDrop={handleChatDrop}
          >
          <div
            aria-label="Boardroom conversation"
            className="chat-thread"
            ref={chatThreadRef}
            role="tabpanel"
          >
            {meeting.chatMessages.length === 0 && streamedChatMessages.length === 0 ? (
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
              [...meeting.chatMessages, ...streamedChatMessages].map((message) => (
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
                    <div className="chat-message-header">
                      <span className="chat-speaker">
                        {message.role === 'user'
                          ? 'You'
                          : message.role === 'facilitator'
                            ? `Board synthesis · ${message.agentName ?? facilitator}`
                            : `${message.agentName ?? 'Advisor'}${message.agentRole ? ` · ${message.agentRole}` : ''}`}
                      </span>
                      {message.role !== 'user' && (
                        <button
                          className="text-button chat-copy-button"
                          onClick={() => copyMessageContent(message.id, message.content)}
                          type="button"
                        >
                          {copiedMessageId === message.id ? 'Copied' : 'Copy'}
                        </button>
                      )}
                    </div>
                    <div className="chat-bubble chat-markdown">
                      {renderChatMarkdown(displayChatContent(message))}
                    </div>
                    {message.imageUrl && (
                      <div className="chat-image-attachment">
                        <a
                          className="chat-image-link"
                          href={message.imageUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          <img
                            alt={`Image from ${message.role === 'user' ? 'you' : (message.agentName ?? 'the boardroom')}`}
                            className="chat-image-result"
                            loading="lazy"
                            src={message.imageUrl}
                          />
                        </a>
                        <div className="chat-image-actions">
                          <button
                            className="text-button"
                            onClick={() =>
                              void reuseImageInChat(
                                message.imageUrl!,
                                message.role === 'user'
                                  ? 'attached-image'
                                  : (message.agentName ?? 'generated-image'),
                              )
                            }
                            type="button"
                          >
                            Use in prompt
                          </button>
                          {imageProcessor && (
                            <button
                              className="text-button"
                              onClick={() =>
                                void loadImageIntoUpscaler(
                                  message.imageUrl!,
                                  message.role === 'user'
                                    ? 'attached-image'
                                    : (message.agentName ?? 'generated-image'),
                                )
                              }
                              type="button"
                            >
                              Upscale
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    {message.attachments?.map((attachment) => (
                      <a
                        className="chat-file-attachment"
                        download
                        href={attachment.url}
                        key={attachment.id}
                      >
                        <span aria-hidden="true" className="chat-file-icon">▤</span>
                        <span className="chat-file-attachment-info">
                          <strong>{attachment.name}</strong>
                          <small>
                            {(attachment.size / 1024).toFixed(0)} KB · Download original
                          </small>
                        </span>
                        <span className="chat-file-download">Download</span>
                      </a>
                    ))}
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
            {isRunning && !liveTurn && !liveSynthesis?.content && (
              <div className="chat-thinking" role="status">
                <span className="activity-pulse" />
                {statusMessage || 'The board is thinking…'}
              </div>
            )}
          </div>
          <form className="chat-composer" onSubmit={sendChatMessage}>
            {chatImageFile && (
              <div className="chat-attachment-preview">
                {chatImagePreviewUrl && (
                  <img alt={chatImageFile.name} src={chatImagePreviewUrl} />
                )}
                <div className="chat-attachment-preview-info">
                  <strong>{chatImageFile.name}</strong>
                  <span>{(chatImageFile.size / 1024).toFixed(0)} KB · Attached</span>
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    setChatImageFile(null)
                    setChatAttachmentError('')
                    if (chatImageInputRef.current) chatImageInputRef.current.value = ''
                  }}
                  type="button"
                >
                  Remove
                </button>
              </div>
            )}
            {chatAttachmentFiles.map((file, index) => (
              <div className="chat-attachment-preview" key={`${file.name}-${index}`}>
                <span aria-hidden="true" className="chat-file-icon">▤</span>
                <div className="chat-attachment-preview-info">
                  <strong>{file.name}</strong>
                  <span>{(file.size / 1024).toFixed(0)} KB · Text will be extracted</span>
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    setChatAttachmentFiles((current) =>
                      current.filter((_, fileIndex) => fileIndex !== index),
                    )
                    setChatAttachmentError('')
                  }}
                  type="button"
                >
                  Remove
                </button>
              </div>
            ))}
            {chatAttachmentError && (
              <p className="form-error image-attachment-error" role="alert">
                {chatAttachmentError}
                <button
                  className="text-button"
                  onClick={() => setChatAttachmentError('')}
                  type="button"
                >
                  Dismiss
                </button>
              </p>
            )}
            {chatMemoryWarning && (
              <p className="form-error" role="status">{chatMemoryWarning}</p>
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
                aria-label="Message the board"
                id="boardroom-chat-message"
                maxLength={4_000}
                onPaste={pasteChatImage}
                onChange={(event) => {
                  setChatDraft(event.target.value)
                  setChatCaretPosition(event.target.selectionStart)
                  setDismissMentionSuggestions(false)
                  setMentionSuggestionIndex(0)
                }}
                onKeyDown={(event) => {
                  if (mentionSuggestions.length > 0) {
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
                    return
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
                onSelect={(event) => {
                  setChatCaretPosition(event.currentTarget.selectionStart)
                  setDismissMentionSuggestions(false)
                }}
                placeholder={
                  mentionableAgents[0]
                    ? `Message the board… (Enter to send, Shift+Enter for new line, @ to mention an agent, or drop/paste files)`
                    : 'Message the board… (Enter to send, Shift+Enter for new line)'
                }
                ref={chatInputRef}
                rows={2}
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
                      <span>
                        {agent.role} · {modelCapabilityLabels(agent.modelCapabilities).join(', ') || 'Text'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="chat-composer-footer">
              <div className="chat-composer-tools">
                <label className="secondary-button chat-tool-button">
                  + Image
                  <input
                    accept="image/png,image/jpeg,image/webp"
                    aria-label="Choose an image to attach"
                    className="sr-only-file-input"
                    onChange={(event) => selectChatImage(event.target.files?.[0] ?? null)}
                    ref={chatImageInputRef}
                    type="file"
                  />
                </label>
                <label className="secondary-button chat-tool-button">
                  + Files
                  <input
                    accept=".pdf,.docx,.txt,.md,.markdown,.csv,.xlsx,.pptx"
                    aria-label="Choose documents to attach"
                    className="sr-only-file-input"
                    multiple
                    onChange={(event) => {
                      selectChatAttachments(Array.from(event.target.files ?? []))
                      event.currentTarget.value = ''
                    }}
                    ref={chatFileInputRef}
                    type="file"
                  />
                </label>
                {mentionableAgents.length > 0 && (
                  <button
                    className="secondary-button chat-tool-button"
                    onClick={insertMentionTrigger}
                    type="button"
                  >
                    @ Agent
                  </button>
                )}
                <span className="chat-composer-hint">
                  {meeting.chatType === 'informational'
                    ? hasDirector
                      ? 'Orchestrator routes 1–3 agents by capability'
                      : 'Direct agent replies'
                    : hasDirector
                      ? 'Orchestrator routing · team synthesis'
                      : `${advisorCount} advisor${advisorCount === 1 ? '' : 's'} + synthesis`}
                </span>
              </div>
              {isRunning ? (
                <button className="secondary-button" onClick={stopDiscussion} type="button">
                  Stop response
                </button>
              ) : (
                <button
                  className="primary-button"
                  disabled={
                    (!chatDraft.trim() &&
                      !chatImageFile &&
                      chatAttachmentFiles.length === 0) ||
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
          {meeting.task !== 'Ongoing boardroom chat' && (
            <div
              aria-labelledby="chat-description-heading"
              className="chat-description-popover"
              hidden={!isChatDescriptionExpanded}
              id="chat-description-panel"
              role="region"
            >
              <div className="chat-description-popover-heading">
                <strong id="chat-description-heading">Chat description</strong>
                <button
                  className="text-button"
                  onClick={() => setIsChatDescriptionExpanded(false)}
                  type="button"
                >
                  Close
                </button>
              </div>
              <p>{meeting.task}</p>
            </div>
          )}
          </div>
          </>
          )}
        </>
      ) : meeting.transcript.length === 0 &&
        !meeting.synthesis &&
        !liveTurn &&
        !liveSynthesis ? (
        <div className="empty-boardroom">
          <div className="empty-illustration" aria-hidden="true">
            <span>◌</span><i /><i /><i />
          </div>
          <h3>Your boardroom is ready.</h3>
          <p>Start the discussion when you’re ready. Each advisor will share their perspective.</p>
        </div>
      ) : (
        <div className="discussion">
          {[...meeting.transcript, ...(liveTurn ? [liveTurn] : [])].map((turn) => (
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
          {(meeting.synthesis || liveSynthesis?.content) && (
            <article className="synthesis-card">
              <div className="synthesis-heading">
                <span className="synthesis-mark" aria-hidden="true">✳</span>
                <div>
                  <p className="section-kicker">THE BOARD’S CONCLUSION</p>
                  <h3>Synthesis by {facilitator}</h3>
                </div>
              </div>
              <div className="synthesis-content">
                {liveSynthesis?.content || meeting.synthesis}
              </div>
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
