import type {
  AgentConfig,
  ChatAgentRole,
  ModelCapabilities,
} from './boardroom.ts'

export const CHAT_AGENT_ROLES: readonly ChatAgentRole[] = [
  'advisor',
  'director',
  'researcher',
  'facilitator',
  'critic',
  'synthesizer',
  'image_processor',
  'image_generator',
  'image_analyser',
  'report_formatter',
  'executor',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface MentionedAgent {
  agent: AgentConfig
  prompt: string
}

export function isChatAgentRole(value: unknown): value is ChatAgentRole {
  return CHAT_AGENT_ROLES.some((role) => role === value)
}

export function isDecisionRoutingAgent(
  agent: Pick<AgentConfig, 'provider' | 'model'>,
): boolean {
  return (
    agent.provider === 'openrouter' &&
    agent.model === 'google/gemini-decision-1'
  )
}

export function isTextGenerationAgent(
  agent: Pick<AgentConfig, 'provider' | 'model'>,
): boolean {
  return agent.provider !== 'magnific' && !isDecisionRoutingAgent(agent)
}

export function isSecureImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

export function isBoardroomImageSource(value: unknown): value is string {
  return (
    isSecureImageUrl(value) ||
    (typeof value === 'string' &&
      /^\/api\/boardrooms\/images\/generated\/[0-9a-f-]{36}\.(?:png|jpe?g|webp)$/.test(value))
  )
}

export function normalizeChatAgentRoles(
  agentIds: string[],
  value: unknown,
  preferredDirectorId?: string,
): Record<string, ChatAgentRole> | null {
  let assignments: Record<string, unknown>
  if (value === undefined) {
    assignments = Object.fromEntries(agentIds.map((agentId) => [agentId, 'advisor']))
  } else {
    if (!isRecord(value)) return null
    assignments = value
    if (
      Object.keys(assignments).length !== agentIds.length ||
      agentIds.some((agentId) => !isChatAgentRole(assignments[agentId])) ||
      Object.keys(assignments).some((agentId) => !agentIds.includes(agentId))
    ) {
      return null
    }
  }
  const directorIds = Object.entries(assignments)
    .filter(([, role]) => role === 'director')
    .map(([agentId]) => agentId)
  if (directorIds.length > 1 || (directorIds.length === 1 && agentIds.length < 2)) {
    return null
  }

  const directorId =
    (preferredDirectorId && agentIds.includes(preferredDirectorId)
      ? preferredDirectorId
      : directorIds[0]) ??
    (agentIds.length >= 2 ? agentIds[0] : undefined)
  return Object.fromEntries(
    agentIds.map(
      (agentId): [string, ChatAgentRole] => [
        agentId,
        agentId === directorId ? 'director' : 'advisor',
      ],
    ),
  )
}

export function normalizeModelCapabilities(value: unknown): ModelCapabilities | null {
  if (value === undefined) return {}
  if (!isRecord(value)) return null
  const keys = [
    'supportsDecisionRouting',
    'supportsImageGeneration',
    'supportsImageProcessing',
    'supportsVision',
    'supportsWebSearch',
  ] as const
  if (keys.some((key) => value[key] !== undefined && typeof value[key] !== 'boolean')) {
    return null
  }
  return Object.fromEntries(
    keys.flatMap((key) =>
      typeof value[key] === 'boolean' ? [[key, value[key]]] : [],
    ),
  )
}

export function modelCapabilityLabels(capabilities?: ModelCapabilities): string[] {
  const labels: string[] = []
  if (capabilities?.supportsDecisionRouting) labels.push('Decision routing')
  if (capabilities?.supportsVision) labels.push('Image input')
  if (capabilities?.supportsImageGeneration) labels.push('Image generation')
  if (capabilities?.supportsImageProcessing) labels.push('Image processing')
  if (capabilities?.supportsWebSearch) labels.push('Web search')
  return labels
}

function removeMention(
  message: string,
  start: number,
  end: number,
): string {
  return (
    `${message.slice(0, start)}${message.slice(end)}`
      .replace(/[ \t]{2,}/g, ' ')
      .trim() || 'Please respond to the conversation so far.'
  )
}

export function resolveAgentMention(
  message: string,
  agents: AgentConfig[],
): MentionedAgent | null {
  const bracedMention = /(^|\s)@\{([^}]+)\}\s*(?:[:,;-]\s*)?/.exec(message)
  if (bracedMention) {
    const agent = agents.find(
      (candidate) =>
        candidate.name.toLocaleLowerCase() === bracedMention[2].trim().toLocaleLowerCase(),
    )
    if (agent) {
      const start = bracedMention.index + bracedMention[1].length
      return {
        agent,
        prompt: removeMention(
          message,
          start,
          bracedMention.index + bracedMention[0].length,
        ),
      }
    }
  }

  for (const agent of [...agents].sort((first, second) => second.name.length - first.name.length)) {
    const escapedName = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const mention = new RegExp(`(^|\\s)@${escapedName}(?=$|[\\s,.:;!?-])`, 'i')
    const match = mention.exec(message)
    if (!match) continue
    const start = match.index + match[1].length
    return {
      agent,
      prompt: removeMention(message, start, match.index + match[0].length),
    }
  }
  return null
}
