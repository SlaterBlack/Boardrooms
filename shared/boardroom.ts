export type Provider = 'openai' | 'anthropic' | 'openrouter' | 'magnific'

export interface AgentConfig {
  id: string
  name: string
  role: string
  defaultChatRole: ChatAgentRole
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
}

export interface BoardroomReport {
  id: string
  title: string
  type: BoardroomReportType
  content: string
  createdAt: string
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
  formatterId?: string
}

export type BoardroomEvent =
  | { type: 'round_start'; round: number; totalRounds: number }
  | { type: 'route_start'; agentId: string; agentName: string }
  | { type: 'route_complete'; agentId: string; agentName: string }
  | { type: 'turn_start'; agentId: string; agentName: string; round: number }
  | { type: 'turn_complete'; turn: BoardroomTurn }
  | { type: 'synthesis_start'; agentId: string; agentName: string }
  | {
      type: 'synthesis_complete'
      agentId: string
      agentName: string
      content: string
    }
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
  openrouter: boolean
  magnific: boolean
}

export interface ProviderModel {
  id: string
  name: string
  isFree?: boolean
  supportsImageGeneration?: boolean
  supportsImageProcessing?: boolean
  supportsVision?: boolean
  supportsWebSearch?: boolean
}

export interface ModelCapabilities {
  supportsImageGeneration?: boolean
  supportsImageProcessing?: boolean
  supportsVision?: boolean
  supportsWebSearch?: boolean
}
