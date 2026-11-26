export type Provider = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'magnific'

export interface AgentConfig {
  id: string
  name: string
  role: string
  provider: Provider
  model: string
  modelCapabilities?: ModelCapabilities
  knowledge: string
  skills: string
  instructions: string
}

export type MeetingStatus = 'ready' | 'running' | 'completed' | 'interrupted'
export type MeetingMode = 'discussion' | 'chat'
export type ChatType = 'informational' | 'document'
export type ChatAgentRole =
  | 'advisor'
  | 'director'
  | 'researcher'
  | 'facilitator'
  | 'critic'
  | 'synthesizer'
  | 'image_processor'
  | 'image_generator'
  | 'image_analyser'
  | 'report_formatter'
  | 'executor'
export type ChatMessageRole = 'user' | 'agent' | 'facilitator'
export type BoardroomReportType = 'scope' | 'review' | 'custom'

export interface BoardroomTurn {
  id: string
  agentId: string
  agentName: string
  agentRole: string
  round: number
  content: string
  imageUrl?: string
}

export interface BoardroomChatMessage {
  id: string
  role: ChatMessageRole
  content: string
  createdAt: string
  agentId?: string
  agentName?: string
  agentRole?: string
  imageUrl?: string
  attachments?: BoardroomChatAttachment[]
}

export const MAX_BOARDROOM_CHAT_ATTACHMENTS = 3
export const MAX_BOARDROOM_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_BOARDROOM_CHAT_ATTACHMENT_TEXT_LENGTH = 12_000
export const MAX_BOARDROOM_CHAT_ATTACHMENT_CONTEXT_LENGTH = 18_000

export interface BoardroomChatAttachment {
  id: string
  name: string
  size: number
  contentType: string
  url: string
  extractedText: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isBoardroomChatAttachment(
  value: unknown,
): value is BoardroomChatAttachment {
  if (!isRecord(value)) return false
  const attachment = value
  return (
    typeof attachment.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      attachment.id,
    ) &&
    typeof attachment.name === 'string' &&
    attachment.name.trim().length > 0 &&
    attachment.name.length <= 160 &&
    typeof attachment.size === 'number' &&
    Number.isSafeInteger(attachment.size) &&
    attachment.size > 0 &&
    attachment.size <= MAX_BOARDROOM_CHAT_ATTACHMENT_BYTES &&
    typeof attachment.contentType === 'string' &&
    typeof attachment.url === 'string' &&
    attachment.url.startsWith(`/api/boardrooms/files/${attachment.id}?name=`) &&
    typeof attachment.extractedText === 'string' &&
    attachment.extractedText.length > 0 &&
    attachment.extractedText.length <= MAX_BOARDROOM_CHAT_ATTACHMENT_TEXT_LENGTH
  )
}

export interface BoardroomReport {
  id: string
  title: string
  type: BoardroomReportType
  content: string
  createdAt: string
}

export const MAX_BOARDROOM_CHAT_MEMORY_LENGTH = 3_000

export interface BoardroomChatMemory {
  summary: string
  throughMessageCount: number
}

export interface Meeting {
  id: string
  name: string
  task: string
  mode: MeetingMode
  chatType: ChatType
  agents: AgentConfig[]
  agentRoles: Record<string, ChatAgentRole>
  facilitatorId: string
  rounds: number
  createdAt: string
  updatedAt: string
  status: MeetingStatus
  transcript: BoardroomTurn[]
  chatMessages: BoardroomChatMessage[]
  chatMemory?: BoardroomChatMemory
  reports: BoardroomReport[]
  synthesis: string
  error: string
}

export interface BoardroomRunInput {
  meetingId?: string
  directAgentId?: string
  task: string
  context?: string
  imageDataUrl?: string
  synthesize?: boolean
  agentRoles?: Record<string, ChatAgentRole>
  agents: AgentConfig[]
  rounds: number
  facilitatorId: string
}

export interface BoardroomReportInput {
  title: string
  type: BoardroomReportType
  instructions: string
  context: string
  agents: AgentConfig[]
  agentRoles?: Record<string, ChatAgentRole>
  facilitatorId: string
}

export type BoardroomEvent =
  | { type: 'round_start'; round: number; totalRounds: number }
  | { type: 'route_start'; agentId: string; agentName: string }
  | { type: 'route_complete'; agentId: string; agentName: string }
  | { type: 'turn_start'; agentId: string; agentName: string; round: number }
  | {
      type: 'turn_delta'
      turnId: string
      agentId: string
      agentName: string
      agentRole: string
      round: number
      delta: string
    }
  | { type: 'turn_complete'; turn: BoardroomTurn }
  | { type: 'synthesis_start'; messageId: string; agentId: string; agentName: string }
  | { type: 'synthesis_delta'; messageId: string; delta: string }
  | {
      type: 'synthesis_complete'
      messageId: string
      agentId: string
      agentName: string
      content: string
    }
  | { type: 'chat_memory_start' }
  | { type: 'chat_memory_update'; summary: string }
  | { type: 'chat_memory_error'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

export type BoardroomReportEvent =
  | { type: 'section_start'; agentId: string; agentName: string }
  | { type: 'section_complete'; agentId: string; agentName: string }
  | { type: 'facilitator_start'; agentId: string; agentName: string }
  | { type: 'report_complete'; content: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

export interface ProviderAvailability {
  openai: boolean
  anthropic: boolean
  gemini: boolean
  openrouter: boolean
  magnific: boolean
}

export interface ProviderModel {
  id: string
  name: string
  isFree?: boolean
  supportsDecisionRouting?: boolean
  supportsImageGeneration?: boolean
  supportsImageProcessing?: boolean
  supportsVision?: boolean
  supportsWebSearch?: boolean
}

export interface ModelCapabilities {
  supportsDecisionRouting?: boolean
  supportsImageGeneration?: boolean
  supportsImageProcessing?: boolean
  supportsVision?: boolean
  supportsWebSearch?: boolean
}
