import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type {
  AgentConfig,
  BoardroomEvent,
  BoardroomReportEvent,
  BoardroomReportInput,
  BoardroomReportType,
  BoardroomRunInput,
  BoardroomTurn,
  Provider,
} from '../shared/boardroom.ts'

export const MAX_AGENTS = 5
export const MAX_ROUNDS = 3
export const MAX_CONTEXT_LENGTH = 24_000

export class BoardroomInputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readText(
  value: unknown,
  field: string,
  maximumLength: number,
  required = true,
): string {
  if (typeof value !== 'string') {
    if (!required && value === undefined) return ''
    throw new BoardroomInputError(`${field} must be a string.`)
  }

  const text = value.trim()
  if (required && !text) {
    throw new BoardroomInputError(`${field} is required.`)
  }
  if (text.length > maximumLength) {
    throw new BoardroomInputError(`${field} must be ${maximumLength} characters or fewer.`)
  }
  return text
}

export function parseBoardroomInput(value: unknown): BoardroomRunInput {
  if (!isRecord(value)) {
    throw new BoardroomInputError('Request body must be an object.')
  }

  const task = readText(value.task, 'Task', 8_000)
  const context = readText(
    value.context,
    'Conversation context',
    MAX_CONTEXT_LENGTH,
    false,
  )
  if (!Array.isArray(value.agents) || value.agents.length < 1) {
    throw new BoardroomInputError('Add at least one agent to the boardroom.')
  }
  if (value.agents.length > MAX_AGENTS) {
    throw new BoardroomInputError(`A boardroom can have at most ${MAX_AGENTS} agents.`)
  }

  const seenIds = new Set<string>()
  const agents = value.agents.map((value, index): AgentConfig => {
    if (!isRecord(value)) {
      throw new BoardroomInputError(`Agent ${index + 1} must be an object.`)
    }

    const id = readText(value.id, `Agent ${index + 1} ID`, 80)
    if (seenIds.has(id)) {
      throw new BoardroomInputError('Agent IDs must be unique.')
    }
    seenIds.add(id)

    const provider = value.provider
    if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'openrouter') {
      throw new BoardroomInputError(`Agent ${index + 1} has an unsupported provider.`)
    }

    const model = readText(value.model, `Agent ${index + 1} model`, 120)
    const validModel = provider === 'openrouter'
      ? /^[a-zA-Z0-9._:/-]+$/.test(model)
      : /^[a-zA-Z0-9._:-]+$/.test(model)
    if (!validModel) {
      throw new BoardroomInputError(`Agent ${index + 1} has an invalid model ID.`)
    }

    return {
      id,
      name: readText(value.name, `Agent ${index + 1} name`, 80),
      role: readText(value.role, `Agent ${index + 1} role`, 120),
      provider,
      model,
      knowledge: readText(
        value.knowledge,
        `Agent ${index + 1} knowledge`,
        1_200,
        false,
      ),
      skills: readText(value.skills, `Agent ${index + 1} skills`, 1_200, false),
      instructions: readText(
        value.instructions,
        `Agent ${index + 1} instructions`,
        2_000,
        false,
      ),
    }
  })

  const rounds = value.rounds === undefined ? 2 : value.rounds
  if (
    typeof rounds !== 'number' ||
    !Number.isInteger(rounds) ||
    rounds < 1 ||
    rounds > MAX_ROUNDS
  ) {
    throw new BoardroomInputError(`Rounds must be a whole number from 1 to ${MAX_ROUNDS}.`)
  }

  const facilitatorId =
    value.facilitatorId === undefined
      ? agents[0].id
      : readText(value.facilitatorId, 'Facilitator ID', 80)
  if (!agents.some((agent) => agent.id === facilitatorId)) {
    throw new BoardroomInputError('Choose a facilitator from the agents in this boardroom.')
  }

  return {
    task,
    ...(context ? { context } : {}),
    agents,
    rounds,
    facilitatorId,
  }
}

export function parseBoardroomReportInput(value: unknown): BoardroomReportInput {
  if (!isRecord(value)) {
    throw new BoardroomInputError('Request body must be an object.')
  }
  if (value.type !== 'scope' && value.type !== 'review' && value.type !== 'custom') {
    throw new BoardroomInputError('Choose a supported report type.')
  }

  const title = readText(value.title, 'Report title', 120)
  const instructions = readText(
    value.instructions,
    'Report instructions',
    4_000,
    false,
  )
  const validated = parseBoardroomInput({
    task: `Prepare a ${value.type} report titled "${title}".`,
    context: value.context,
    agents: value.agents,
    rounds: 1,
    facilitatorId: value.facilitatorId,
  })

  return {
    title,
    type: value.type as BoardroomReportType,
    instructions,
    context: validated.context ?? '',
    agents: validated.agents,
    facilitatorId: validated.facilitatorId,
  }
}

function formatTranscript(transcript: BoardroomTurn[]): string {
  if (transcript.length === 0) return 'No one has spoken yet.'

  return transcript
    .map(
      (turn) =>
        `Round ${turn.round} — ${turn.agentName} (${turn.agentRole}):\n${turn.content}`,
    )
    .join('\n\n')
}

function buildDiscussionPrompt(
  task: string,
  transcript: BoardroomTurn[],
  round: number,
  totalRounds: number,
  context?: string,
): string {
  const guidance =
    round === 1
      ? context
        ? 'Respond to the user’s latest message in light of the ongoing conversation. Identify important assumptions, risks, and practical next steps.'
        : 'Give your independent perspective. Identify important assumptions, risks, and a practical recommendation.'
      : 'Respond to the discussion so far. Build on useful ideas, respectfully challenge weak assumptions, and refine your recommendation.'

  const conversation = context ? `Ongoing conversation so far:\n${context}\n\n` : ''
  return `${conversation}Board task or latest user message:
${task}

Discussion so far:
${formatTranscript(transcript)}

Your turn (${round} of ${totalRounds}): ${guidance}
Be specific and concise. Keep your contribution under 200 words.`
}

function buildSystemPrompt(agent: AgentConfig): string {
  const knowledge = agent.knowledge
    ? `\nRelevant knowledge and background:\n${agent.knowledge}`
    : ''
  const skills = agent.skills ? `\nSkills and methods:\n${agent.skills}` : ''
  const extraInstructions = agent.instructions
    ? `\nAdditional guidance from the user:\n${agent.instructions}`
    : ''

  return `You are ${agent.name}, serving as ${agent.role} in a collaborative boardroom. Bring the knowledge and perspective of this role, distinguish facts from assumptions, and be constructive with the other advisors.${knowledge}${skills}${extraInstructions}`
}

function openAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.')
  return new OpenAI({ apiKey, maxRetries: 1, timeout: 90_000 })
}

function anthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured.')
  return new Anthropic({ apiKey, maxRetries: 1, timeout: 90_000 })
}

function openRouterClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured.')
  return new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    maxRetries: 1,
    timeout: 90_000,
  })
}

async function complete(
  agent: AgentConfig,
  system: string,
  prompt: string,
  signal: AbortSignal,
  maxOutputTokens = 700,
): Promise<string> {
  let content: string
  if (agent.provider === 'openai') {
    const response = await openAIClient().responses.create(
      {
        model: agent.model,
        instructions: system,
        input: prompt,
        max_output_tokens: maxOutputTokens,
      },
      { signal },
    )
    content = response.output_text
  } else if (agent.provider === 'openrouter') {
    const response = await openRouterClient().chat.completions.create(
      {
        model: agent.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        max_tokens: maxOutputTokens,
      },
      { signal },
    )
    content = response.choices[0]?.message.content ?? ''
  } else {
    const response = await anthropicClient().messages.create(
      {
        model: agent.model,
        system,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxOutputTokens,
      },
      { signal },
    )
    content = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  }

  const text = content.trim()
  if (!text) throw new Error(`${agent.provider} returned an empty response.`)
  return text
}

function providerLabel(provider: Provider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI'
    case 'anthropic':
      return 'Anthropic'
    case 'openrouter':
      return 'OpenRouter'
  }
}

function providerErrorMessage(provider: Provider, error: unknown): string {
  const status =
    isRecord(error) && typeof error.status === 'number' ? error.status : undefined
  const label = providerLabel(provider)

  if (status === 401 || status === 403) {
    return `${label} rejected the API key. Check the server environment variable.`
  }
  if (status === 404) {
    return `${label} could not find this model. Check the model ID.`
  }
  if (status === 429) {
    if (provider === 'openrouter') {
      return 'OpenRouter reports its rate or usage limit has been reached. Free model pricing does not bypass account limits; check the OpenRouter account or choose another provider.'
    }
    return `${label} rate limit or usage limit reached. Check the provider account.`
  }
  if (error instanceof Error && error.message.endsWith('returned an empty response.')) {
    return error.message
  }
  return `${label} request failed. Check the model ID, API key, and provider availability.`
}

export async function runBoardroom(
  input: BoardroomRunInput,
  emit: (event: BoardroomEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const transcript: BoardroomTurn[] = []

  for (let round = 1; round <= input.rounds; round += 1) {
    emit({ type: 'round_start', round, totalRounds: input.rounds })

    for (const agent of input.agents) {
      if (signal.aborted) return
      emit({ type: 'turn_start', agentId: agent.id, agentName: agent.name, round })

      let content: string
      try {
        content = await complete(
          agent,
          buildSystemPrompt(agent),
          buildDiscussionPrompt(
            input.task,
            transcript,
            round,
            input.rounds,
            input.context,
          ),
          signal,
        )
      } catch (error) {
        if (signal.aborted) return
        throw new Error(providerErrorMessage(agent.provider, error))
      }

      const turn: BoardroomTurn = {
        id: crypto.randomUUID(),
        agentId: agent.id,
        agentName: agent.name,
        agentRole: agent.role,
        round,
        content,
      }
      transcript.push(turn)
      emit({ type: 'turn_complete', turn })
    }
  }

  if (signal.aborted) return
  const facilitator = input.agents.find((agent) => agent.id === input.facilitatorId)!
  emit({
    type: 'synthesis_start',
    agentId: facilitator.id,
    agentName: facilitator.name,
  })

  let synthesis: string
  const priorConversation = input.context
    ? `\n\nEarlier conversation:\n${input.context}`
    : ''
  try {
    synthesis = await complete(
      facilitator,
      `${buildSystemPrompt(facilitator)}\n\nYou are now the boardroom facilitator. Synthesize the entire discussion into a balanced, decision-ready conclusion. Do not invent consensus; name unresolved disagreements or uncertainty.`,
      `Board task or latest user message:\n${input.task}${priorConversation}\n\nFull discussion:\n${formatTranscript(transcript)}\n\nWrite a concise synthesis with these headings: Conclusion, Key considerations, Recommended next steps. Attribute important viewpoints to the advisor who raised them.`,
      signal,
    )
  } catch (error) {
    if (signal.aborted) return
    throw new Error(providerErrorMessage(facilitator.provider, error))
  }

  emit({
    type: 'synthesis_complete',
    agentId: facilitator.id,
    agentName: facilitator.name,
    content: synthesis,
  })
  emit({ type: 'done' })
}

function reportTypeLabel(type: BoardroomReportType): string {
  switch (type) {
    case 'scope':
      return 'scope document'
    case 'review':
      return 'review document'
    case 'custom':
      return 'custom report'
  }
}

function reportTypeGuidance(type: BoardroomReportType): string {
  switch (type) {
    case 'scope':
      return 'Cover the project brief, objectives, proposed scope, deliverables, exclusions, assumptions, dependencies, risks, responsibilities, and next steps. Mark unknown items as decisions or information to confirm.'
    case 'review':
      return 'Cover the review purpose and criteria, key findings, strengths, issues and risks, recommendations with priorities, assumptions, and follow-up actions. Distinguish evidence from opinion.'
    case 'custom':
      return 'Use clear, useful sections that fit the user’s instructions and the boardroom context.'
  }
}

export async function generateBoardroomReport(
  input: BoardroomReportInput,
  emit: (event: BoardroomReportEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const contributions: Array<{ agent: AgentConfig; content: string }> = []
  for (const agent of input.agents) {
    if (signal.aborted) return
    emit({ type: 'section_start', agentId: agent.id, agentName: agent.name })

    let content: string
    try {
      content = await complete(
        agent,
        `${buildSystemPrompt(agent)}\n\nYou are a subject-matter contributor to a professional ${reportTypeLabel(input.type)}. Write only the report sections where your expertise adds value.`,
        `Document title: ${input.title}
Report type: ${reportTypeLabel(input.type)}

Boardroom conversation and conclusion:
${input.context}

User's report instructions:
${input.instructions || 'Use the report type and conversation to determine the appropriate detail.'}

Report guidance:
${reportTypeGuidance(input.type)}

Write one or more concise, titled sections from your perspective. Be specific and practical. Identify assumptions and missing information instead of inventing facts. Avoid repeating generic background or claiming agreement on behalf of other advisors.`,
        signal,
        1_500,
      )
    } catch (error) {
      if (signal.aborted) return
      throw new Error(providerErrorMessage(agent.provider, error))
    }

    contributions.push({ agent, content })
    emit({ type: 'section_complete', agentId: agent.id, agentName: agent.name })
  }

  if (signal.aborted) return
  const facilitator = input.agents.find((agent) => agent.id === input.facilitatorId)!
  emit({
    type: 'facilitator_start',
    agentId: facilitator.id,
    agentName: facilitator.name,
  })

  const advisorSections = contributions
    .map(
      ({ agent, content }) =>
        `${agent.name} (${agent.role}):\n${content}`,
    )
    .join('\n\n')

  let content: string
  try {
    content = await complete(
      facilitator,
      `${buildSystemPrompt(facilitator)}\n\nYou are the report editor and boardroom facilitator. Produce a complete, professional document from the advisor contributions. Keep role-specific expertise visible, reconcile differences transparently, and do not invent facts or consensus.`,
      `Document title: ${input.title}
Report type: ${reportTypeLabel(input.type)}

Boardroom conversation and conclusion:
${input.context}

User's report instructions:
${input.instructions || 'Use the report type and conversation to determine the appropriate detail.'}

Report guidance:
${reportTypeGuidance(input.type)}

Advisor contributions:
${advisorSections}

Write the finished report in Markdown with a clear title, an executive summary, useful sections, and prioritized recommendations or next steps. Incorporate relevant advisor contributions, name the perspectives behind important findings, and clearly label assumptions or items that need confirmation.`,
      signal,
      4_000,
    )
  } catch (error) {
    if (signal.aborted) return
    throw new Error(providerErrorMessage(facilitator.provider, error))
  }

  emit({ type: 'report_complete', content })
  emit({ type: 'done' })
}
