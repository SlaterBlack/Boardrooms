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

export interface MentionedAdvisor {
  agent: AgentConfig
  prompt: string
}

export function isChatAgentRole(value: unknown): value is ChatAgentRole {
  return CHAT_AGENT_ROLES.some((role) => role === value)
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
): Record<string, ChatAgentRole> | null {
  if (value === undefined) {
    const roles: Array<[string, ChatAgentRole]> = agentIds.map((agentId) => [
      agentId,
      'advisor',
    ])
    return Object.fromEntries(roles)
  }
  if (!isRecord(value)) return null
  const assignments = value
  if (
    Object.keys(assignments).length !== agentIds.length ||
    agentIds.some((agentId) => !isChatAgentRole(assignments[agentId])) ||
    Object.keys(assignments).some((agentId) => !agentIds.includes(agentId))
  ) {
    return null
  }

  const entries: Array<[string, ChatAgentRole]> = []
  for (const agentId of agentIds) {
    const role = assignments[agentId]
    if (!isChatAgentRole(role)) return null
    entries.push([agentId, role])
  }
  const roles = Object.fromEntries(entries)
  const specializedRoles = Object.values(roles).filter((role) => role !== 'advisor')
  if (
    new Set(specializedRoles).size !== specializedRoles.length ||
    !Object.values(roles).includes('advisor')
  ) {
    return null
  }

  return roles
}

export function normalizeDefaultChatRole(value: unknown): ChatAgentRole | null {
  if (value === undefined) return 'advisor'
  return isChatAgentRole(value) ? value : null
}

export function normalizeModelCapabilities(value: unknown): ModelCapabilities | null {
  if (value === undefined) return {}
  if (!isRecord(value)) return null
  const keys = [
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

function stripMentionRemainder(message: string, offset: number): string {
  return (
    message
      .slice(offset)
      .replace(/^[\s,:;-]+/, '')
      .trim() || 'Please respond to the conversation so far.'
  )
}

export function resolveAdvisorMention(
  message: string,
  agents: AgentConfig[],
): MentionedAdvisor | null {
  const trimmed = message.trimStart()
  const bracedMention = /^@\{([^}]+)\}\s*(?:[:,;-]\s*)?/.exec(trimmed)
  if (bracedMention) {
    const agent = agents.find(
      (candidate) =>
        candidate.name.toLocaleLowerCase() === bracedMention[1].trim().toLocaleLowerCase(),
    )
    if (agent) {
      return {
        agent,
        prompt: stripMentionRemainder(trimmed, bracedMention[0].length),
      }
    }
  }

  const agent = [...agents]
    .sort((first, second) => second.name.length - first.name.length)
    .find((candidate) => {
      const mention = `@${candidate.name}`
      const prefix = trimmed.slice(0, mention.length)
      const nextCharacter = trimmed[mention.length]
      return (
        prefix.toLocaleLowerCase() === mention.toLocaleLowerCase() &&
        (nextCharacter === undefined || /[\s,.:;!?-]/.test(nextCharacter))
      )
    })

  if (!agent) return null
  return {
    agent,
    prompt: stripMentionRemainder(trimmed, agent.name.length + 1),
  }
}
