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

export interface BoardroomTurn {
  id: string
  agentId: string
  agentName: string
  agentRole: string
  round: number
  content: string
}

export interface Meeting {
  id: string
  name: string
  task: string
  agents: AgentConfig[]
  facilitatorId: string
  rounds: number
  createdAt: string
  updatedAt: string
  status: MeetingStatus
  transcript: BoardroomTurn[]
  synthesis: string
  error: string
}

export interface BoardroomRunInput {
  task: string
  agents: AgentConfig[]
  rounds: number
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

export interface ProviderAvailability {
  openai: boolean
  anthropic: boolean
  openrouter: boolean
}
