import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type {
  AgentConfig,
  BoardroomEvent,
  BoardroomRunInput,
  BoardroomTurn,
  Provider,
} from '../shared/boardroom.ts'

export const MAX_AGENTS = 5
export const MAX_ROUNDS = 3

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
    if (provider !== 'openai' && provider !== 'anthropic') {
      throw new BoardroomInputError(`Agent ${index + 1} has an unsupported provider.`)
    }

    const model = readText(value.model, `Agent ${index + 1} model`, 120)
    if (!/^[a-zA-Z0-9._:-]+$/.test(model)) {
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

  return { task, agents, rounds, facilitatorId }
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
): string {
  const guidance =
    round === 1
      ? 'Give your independent perspective. Identify important assumptions, risks, and a practical recommendation.'
      : 'Respond to the discussion so far. Build on useful ideas, respectfully challenge weak assumptions, and refine your recommendation.'

  return `Board task:
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

async function complete(
  agent: AgentConfig,
  system: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  let content: string
  if (agent.provider === 'openai') {
    const response = await openAIClient().responses.create(
      {
        model: agent.model,
        instructions: system,
        input: prompt,
        max_output_tokens: 700,
      },
      { signal },
    )
    content = response.output_text
  } else {
    const response = await anthropicClient().messages.create(
      {
        model: agent.model,
        system,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 700,
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
  return provider === 'openai' ? 'OpenAI' : 'Anthropic'
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
          buildDiscussionPrompt(input.task, transcript, round, input.rounds),
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
  try {
    synthesis = await complete(
      facilitator,
      `${buildSystemPrompt(facilitator)}\n\nYou are now the boardroom facilitator. Synthesize the entire discussion into a balanced, decision-ready conclusion. Do not invent consensus; name unresolved disagreements or uncertainty.`,
      `Board task:\n${input.task}\n\nFull discussion:\n${formatTranscript(transcript)}\n\nWrite a concise synthesis with these headings: Conclusion, Key considerations, Recommended next steps. Attribute important viewpoints to the advisor who raised them.`,
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
