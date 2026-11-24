export type Provider = 'openai' | 'anthropic' | 'openrouter'

export interface AgentConfig {
  id: string
  name: string
  role: string
  provider: Provider
  model: string
  knowledge: string
  skills: string
  instructions: string
}

export type MeetingStatus = 'ready' | 'running' | 'completed' | 'interrupted'
export type MeetingMode = 'discussion' | 'chat'
export type ChatMessageRole = 'user' | 'agent' | 'facilitator'
export type BoardroomReportType = 'scope' | 'review' | 'custom'

export interface BoardroomTurn {
  id: string
  agentId: string
  agentName: string
  agentRole: string
  round: number
  content: string
}

export interface BoardroomChatMessage {
  id: string
  role: ChatMessageRole
  content: string
  createdAt: string
  agentId?: string
  agentName?: string
  agentRole?: string
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
  agents: AgentConfig[]
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
  task: string
  context?: string
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
  facilitatorId: string
}

export type BoardroomEvent =
  | { type: 'round_start'; round: number; totalRounds: number }
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
}

export interface ProviderModel {
  id: string
  name: string
  isFree?: boolean
}
