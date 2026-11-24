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
  ChatAgentRole,
  Provider,
} from '../shared/boardroom.ts'
import {
  isSecureImageUrl,
  normalizeChatAgentRoles,
  normalizeDefaultChatRole,
  normalizeModelCapabilities,
} from '../shared/chat.ts'
import { persistGeneratedImage } from './generatedImages.ts'
import { generateWithMagnific, MagnificError } from './magnific.ts'

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

function readImageDataUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new BoardroomInputError('Attach a PNG, JPEG, or WebP image for analysis.')
  }
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match) {
    throw new BoardroomInputError('Attach a PNG, JPEG, or WebP image for analysis.')
  }
  const bytes = Buffer.from(match[2], 'base64')
  if (
    bytes.length === 0 ||
    bytes.length > 7 * 1024 * 1024 ||
    bytes.toString('base64') !== match[2]
  ) {
    throw new BoardroomInputError('Images for analysis must be valid and no larger than 7 MB.')
  }
  return value
}

export function parseBoardroomInput(value: unknown): BoardroomRunInput {
  if (!isRecord(value)) {
    throw new BoardroomInputError('Request body must be an object.')
  }

  const task = readText(value.task, 'Task', 8_000)
  const meetingId =
    value.meetingId === undefined
      ? undefined
      : readText(value.meetingId, 'Meeting ID', 80)
  const context = readText(
    value.context,
    'Conversation context',
    MAX_CONTEXT_LENGTH,
    false,
  )
  const imageDataUrl = readImageDataUrl(value.imageDataUrl)
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
    if (
      provider !== 'openai' &&
      provider !== 'anthropic' &&
      provider !== 'openrouter' &&
      provider !== 'magnific'
    ) {
      throw new BoardroomInputError(`Agent ${index + 1} has an unsupported provider.`)
    }

    const model = readText(value.model, `Agent ${index + 1} model`, 120)
    const validModel = provider === 'openrouter'
      ? /^[a-zA-Z0-9._:/-]+$/.test(model)
      : /^[a-zA-Z0-9._:-]+$/.test(model)
    if (!validModel) {
      throw new BoardroomInputError(`Agent ${index + 1} has an invalid model ID.`)
    }
    const defaultChatRole = normalizeDefaultChatRole(value.defaultChatRole)
    const modelCapabilities = normalizeModelCapabilities(value.modelCapabilities)
    if (!defaultChatRole || !modelCapabilities) {
      throw new BoardroomInputError(`Agent ${index + 1} has invalid role or model capabilities.`)
    }

    return {
      id,
      name: readText(value.name, `Agent ${index + 1} name`, 80),
      role: readText(value.role, `Agent ${index + 1} role`, 120),
      defaultChatRole,
      provider,
      model,
      modelCapabilities,
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

  const agentRoles = normalizeChatAgentRoles(
    agents.map((agent) => agent.id),
    value.agentRoles,
  )
  if (!agentRoles) {
    throw new BoardroomInputError(
      'Assign each agent one valid role, assign each specialist role only once, and include at least one Meeting Member.',
    )
  }
  for (const agent of agents) {
    const role = agentRoles[agent.id]
    if (
      agent.provider === 'magnific' &&
      role !== 'image_generator' &&
      role !== 'image_processor'
    ) {
      throw new BoardroomInputError(
        'Magnific can only be assigned to Image Generator or Image Processor roles.',
      )
    }
    if (
      imageDataUrl &&
      !Object.values(agentRoles).some((role) => role === 'image_analyser')
    ) {
      throw new BoardroomInputError('Add an Image Analyser to review the attached image.')
    }
    if (role === 'image_generator' && !agent.modelCapabilities?.supportsImageGeneration) {
      throw new BoardroomInputError(
        `The selected model for ${agent.name} does not support image generation.`,
      )
    }
    if (
      role === 'image_processor' &&
      agent.provider === 'magnific' &&
      !agent.modelCapabilities?.supportsImageProcessing
    ) {
      throw new BoardroomInputError(
        `The selected Magnific model for ${agent.name} does not support image processing.`,
      )
    }
    if (role === 'image_analyser' && !agent.modelCapabilities?.supportsVision) {
      throw new BoardroomInputError(
        `The selected model for ${agent.name} does not support image input.`,
      )
    }
    if (role === 'researcher' && !agent.modelCapabilities?.supportsWebSearch) {
      throw new BoardroomInputError(
        `The selected model for ${agent.name} does not support web search.`,
      )
    }
  }

  const rounds = value.rounds === undefined ? 2 : value.rounds
  if (
    typeof rounds !== 'number' ||
    !Number.isInteger(rounds) ||
    rounds < 1 ||
    rounds > MAX_ROUNDS
  ) {
    throw new BoardroomInputError(`Rounds must be a whole number from 1 to ${MAX_ROUNDS}.`)
  }

  const synthesize = value.synthesize === undefined ? true : value.synthesize
  if (typeof synthesize !== 'boolean') {
    throw new BoardroomInputError('Synthesize must be a boolean.')
  }

  const facilitatorId =
    value.facilitatorId === undefined
      ? agents[0].id
      : readText(value.facilitatorId, 'Facilitator ID', 80)
  if (!agents.some((agent) => agent.id === facilitatorId)) {
    throw new BoardroomInputError('Choose a facilitator from the agents in this boardroom.')
  }
  if (agentRoles[facilitatorId] !== 'advisor') {
    throw new BoardroomInputError('Choose an advisor as the boardroom facilitator.')
  }
  const directAgentId =
    value.directAgentId === undefined
      ? undefined
      : readText(value.directAgentId, 'Direct agent ID', 80)
  if (
    directAgentId &&
    (!agents.some((agent) => agent.id === directAgentId) ||
      agentRoles[directAgentId] === 'director' ||
      agentRoles[directAgentId] === 'image_processor')
  ) {
    throw new BoardroomInputError('Choose a responding agent from this boardroom.')
  }

  return {
    ...(meetingId ? { meetingId } : {}),
    ...(directAgentId ? { directAgentId } : {}),
    task,
    ...(context ? { context } : {}),
    ...(imageDataUrl ? { imageDataUrl } : {}),
    synthesize,
    agentRoles,
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
    agentRoles: value.agentRoles,
  })
  const formatterId =
    value.formatterId === undefined
      ? Object.entries(validated.agentRoles ?? {}).find(([, role]) => role === 'report_formatter')?.[0]
      : readText(value.formatterId, 'Formatter ID', 80)
  if (
    formatterId &&
    validated.agentRoles?.[formatterId] !== 'report_formatter'
  ) {
    throw new BoardroomInputError('Choose a report formatter assigned to this boardroom.')
  }

  return {
    title,
    type: value.type as BoardroomReportType,
    instructions,
    context: validated.context ?? '',
    agents: validated.agents,
    agentRoles: validated.agentRoles,
    facilitatorId: validated.facilitatorId,
    ...(formatterId ? { formatterId } : {}),
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

function chatRoleInstructions(role: ChatAgentRole): string {
  switch (role) {
    case 'advisor':
      return 'Contribute actionable judgment from your assigned specialty. Avoid repeating existing points, and identify domain-specific trade-offs.'
    case 'director':
      return 'Route the latest user request to the minimum effective sequence of one to three assigned agents. You do not answer the request.'
    case 'researcher':
      return 'Ground current or verifiable claims in web research. Cite source URLs, distinguish verified facts from estimates, and flag uncertainty.'
    case 'facilitator':
      return 'When the goal is ambiguous or requirements conflict, ask one concise, high-impact clarifying question before the team commits. Otherwise keep scope focused.'
    case 'critic':
      return 'Stress-test proposals constructively. Identify weak assumptions, risks, edge cases, and practical mitigations.'
    case 'synthesizer':
      return 'Consolidate only the contributions already made. Show agreement, disagreements, trade-offs, and next steps without introducing new domain opinions.'
    case 'image_processor':
      return 'Image processing is handled by the Magnific integration, not a text response.'
    case 'image_generator':
      return 'Create an image that follows the user’s visual brief. Image generation is handled by the assigned image-capable model.'
    case 'image_analyser':
      return 'Describe observable details in the supplied image, separate facts from interpretation, and identify defects or useful improvements.'
    case 'report_formatter':
      return 'Format formal deliverables clearly and consistently while preserving established facts and decisions.'
    case 'executor':
      return 'Turn approved decisions into complete, immediately usable artifacts. State prerequisites and assumptions without reopening settled choices.'
  }
}

function chatRoleLabel(role: ChatAgentRole): string {
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
      return 'Image Processor'
    case 'image_generator':
      return 'Image Generator'
    case 'image_analyser':
      return 'Image Analyser'
    case 'report_formatter':
      return 'Document Formatter'
    case 'executor':
      return 'Executor'
  }
}

function buildSystemPrompt(
  agent: AgentConfig,
  role: ChatAgentRole = agent.defaultChatRole,
): string {
  const knowledge = agent.knowledge
    ? `\nRelevant knowledge and background:\n${agent.knowledge}`
    : ''
  const skills = agent.skills ? `\nSkills and methods:\n${agent.skills}` : ''
  const extraInstructions = agent.instructions
    ? `\nAdditional guidance from the user:\n${agent.instructions}`
    : ''

  return `You are ${agent.name}, serving as ${agent.role} in a collaborative boardroom. Your assigned boardroom role is ${role}. ${chatRoleInstructions(role)} Distinguish facts from assumptions and be constructive with the other participants.${knowledge}${skills}${extraInstructions}`
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

function imageDataParts(imageDataUrl: string): {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  data: string
} {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    imageDataUrl,
  )
  if (!match) throw new Error('The attached image is invalid.')
  const mediaType =
    match[1] === 'image/png'
      ? 'image/png'
      : match[1] === 'image/jpeg'
        ? 'image/jpeg'
        : 'image/webp'
  return { mediaType, data: match[2] }
}

function findImageSource(value: unknown): string | null {
  if (typeof value === 'string') {
    if (isSecureImageUrl(value)) return value
    if (/^data:image\/(?:png|jpeg|webp);base64,/.test(value)) return value
    return null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const source = findImageSource(item)
      if (source) return source
    }
  } else if (isRecord(value)) {
    for (const key of ['url', 'image_url', 'images', 'data']) {
      if (key in value) {
        const source = findImageSource(value[key])
        if (source) return source
      }
    }
  }
  return null
}

async function generateImage(
  agent: AgentConfig,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  if (agent.provider === 'magnific') {
    return generateWithMagnific({ model: agent.model, prompt }, signal)
  }

  if (agent.provider === 'openai') {
    const response = await openAIClient().images.generate(
      { model: agent.model, prompt, size: '1024x1024', n: 1 },
      { signal },
    )
    const image = response.data?.[0]
    if (image?.url && isSecureImageUrl(image.url)) return image.url
    if (image?.b64_json) {
      return persistGeneratedImage(`data:image/png;base64,${image.b64_json}`)
    }
    throw new Error('The image provider did not return a usable image.')
  }

  if (agent.provider === 'openrouter') {
    const generationOptions: Record<string, unknown> = {
      modalities: ['image', 'text'],
    }
    const response = await openRouterClient().chat.completions.create(
      {
        model: agent.model,
        messages: [{ role: 'user', content: prompt }],
        ...generationOptions,
      },
      { signal },
    )
    const image = findImageSource(response.choices[0]?.message)
    if (!image) throw new Error('The image provider did not return a usable image.')
    return image.startsWith('data:')
      ? persistGeneratedImage(image)
      : image
  }

  throw new Error('This provider does not support image generation.')
}

function collectSources(value: unknown, sources = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value)) {
    for (const item of value) collectSources(item, sources)
  } else if (isRecord(value)) {
    const url = value.url
    const title = value.title
    if (
      typeof url === 'string' &&
      url.startsWith('https://') &&
      (typeof title === 'string' || value.type === 'url_citation')
    ) {
      sources.set(url, typeof title === 'string' ? title : url)
    }
    for (const item of Object.values(value)) collectSources(item, sources)
  }
  return sources
}

function appendSources(content: string, value: unknown): string {
  const sources = [...collectSources(value)]
  if (sources.length === 0) return content
  const references = sources
    .map(([url, title]) => `- [${title}](${url})`)
    .join('\n')
  return `${content}\n\nSources:\n${references}`
}

async function complete(
  agent: AgentConfig,
  system: string,
  prompt: string,
  signal: AbortSignal,
  maxOutputTokens = 700,
  role?: ChatAgentRole,
  imageDataUrl?: string,
): Promise<string> {
  let content: string
  if (agent.provider === 'openai') {
    const input: string | OpenAI.Responses.ResponseInput =
      role === 'image_analyser' && imageDataUrl
        ? [{
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              { type: 'input_image', image_url: imageDataUrl, detail: 'auto' },
            ],
          }]
        : prompt
    const response = await openAIClient().responses.create(
      {
        model: agent.model,
        instructions: system,
        input,
        max_output_tokens: maxOutputTokens,
        ...(role === 'researcher'
          ? { tools: [{ type: 'web_search_preview' as const }] }
          : {}),
      },
      { signal },
    )
    content = role === 'researcher'
      ? appendSources(response.output_text, response.output)
      : response.output_text
  } else if (agent.provider === 'openrouter') {
    const response = await openRouterClient().chat.completions.create(
      {
        model: agent.model,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content:
              role === 'image_analyser' && imageDataUrl
                ? [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: imageDataUrl } },
                  ]
                : prompt,
          },
        ],
        max_tokens: maxOutputTokens,
        ...(role === 'researcher' ? { plugins: [{ id: 'web' }] } : {}),
      },
      { signal },
    )
    const message = response.choices[0]?.message
    content =
      typeof message?.content === 'string'
        ? message.content
        : ''
    if (role === 'researcher') content = appendSources(content, message)
  } else if (agent.provider === 'anthropic') {
    const userContent: Anthropic.Messages.ContentBlockParam[] = [{ type: 'text', text: prompt }]
    if (role === 'image_analyser' && imageDataUrl) {
      const image = imageDataParts(imageDataUrl)
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data },
      })
    }
    const response = await anthropicClient().messages.create(
      {
        model: agent.model,
        system,
        messages: [{ role: 'user', content: userContent }],
        max_tokens: maxOutputTokens,
        ...(role === 'researcher'
          ? {
              tools: [{
                type: 'web_search_20250305' as const,
                name: 'web_search',
                max_uses: 3,
              }],
            }
          : {}),
      },
      { signal },
    )
    content = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (role === 'researcher') content = appendSources(content, response.content)
  } else {
    throw new Error('Magnific models can only be used for image roles.')
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
    case 'magnific':
      return 'Magnific'
  }
}

function providerErrorMessage(provider: Provider, error: unknown): string {
  if (error instanceof MagnificError) return error.message
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
  const agentRoles =
    input.agentRoles ??
    Object.fromEntries(input.agents.map((agent) => [agent.id, 'advisor' as ChatAgentRole]))
  const orchestrator = input.agents.find((agent) => agentRoles[agent.id] === 'director')
  const directAgent = input.directAgentId
    ? input.agents.find((agent) => agent.id === input.directAgentId)
    : undefined
  if (input.directAgentId && !directAgent) {
    throw new Error('The requested agent is not part of this boardroom.')
  }
  let respondingAgents = directAgent
    ? [directAgent]
    : input.agents.filter((agent) => agentRoles[agent.id] === 'advisor')

  if (orchestrator && !directAgent) {
    const candidates = input.agents.filter(
      (agent) =>
        agent.id !== orchestrator.id &&
        agentRoles[agent.id] !== 'image_processor' &&
        (agentRoles[agent.id] !== 'image_analyser' || Boolean(input.imageDataUrl)) &&
        (agentRoles[agent.id] !== 'report_formatter' || input.synthesize !== false),
    )
    if (candidates.length === 0) {
      throw new Error('The Orchestrator has no eligible agents to route this request to.')
    }

    emit({
      type: 'route_start',
      agentId: orchestrator.id,
      agentName: orchestrator.name,
    })
    let selection: string
    try {
      selection = await complete(
        orchestrator,
        `${buildSystemPrompt(orchestrator, 'director')}\n\nSelect the minimum effective sequence of one to three agents. If clarification is needed, select only the Facilitator. Include a Researcher for current or verifiable facts, a Critic to stress-test high-impact proposals, a Synthesizer after multiple contributors, an Image Generator for visual creation, and an Image Analyser whenever an image is supplied. Select the Document Formatter for formal deliverables and the Executor for implementation-ready artifacts. Do not select yourself or Image Processor. Return only a JSON array of agent IDs in speaking order.`,
        `Latest user request:\n${input.task}${input.imageDataUrl ? '\nAn image is attached for analysis.' : ''}\n\n${input.context ? `Prior conversation:\n${input.context}\n\n` : ''}Available agents:\n${candidates.map((agent) => `ID: ${agent.id}\nName: ${agent.name}\nBoardroom role: ${agentRoles[agent.id]}\nExpertise: ${agent.role}\nKnowledge: ${agent.knowledge}\nSkills: ${agent.skills}`).join('\n\n')}\n\nReturn a JSON array with one to three IDs in the order they should speak. Do not include an agent that is not listed.`,
        signal,
        200,
        'director',
      )
    } catch (error) {
      if (signal.aborted) return
      throw new Error(providerErrorMessage(orchestrator.provider, error))
    }

    const selectedAgents = parseOrchestratorSelection(selection, candidates)
    if (!selectedAgents) {
      throw new Error('The Orchestrator returned an invalid routing plan. Please try again.')
    }
    respondingAgents = selectedAgents
    for (const agent of respondingAgents) {
      emit({ type: 'route_complete', agentId: agent.id, agentName: agent.name })
    }
  }

  if (input.imageDataUrl) {
    const imageAnalyser = input.agents.find(
      (agent) => agentRoles[agent.id] === 'image_analyser',
    )
    if (imageAnalyser && !respondingAgents.includes(imageAnalyser)) {
      respondingAgents = [imageAnalyser, ...respondingAgents.slice(0, 2)]
    }
  }

  const selectedSynthesizer = respondingAgents.find(
    (agent) => agentRoles[agent.id] === 'synthesizer',
  )
  respondingAgents = respondingAgents.filter(
    (agent) => agentRoles[agent.id] !== 'synthesizer',
  )
  if (selectedSynthesizer && respondingAgents.length === 0) {
    const meetingMember = input.agents.find(
      (agent) => agentRoles[agent.id] === 'advisor',
    )
    if (!meetingMember) {
      throw new Error('The Orchestrator must route at least one contributing agent.')
    }
    respondingAgents = [meetingMember]
  }

  for (let round = 1; round <= input.rounds; round += 1) {
    emit({ type: 'round_start', round, totalRounds: input.rounds })

    for (const agent of respondingAgents) {
      if (signal.aborted) return
      emit({ type: 'turn_start', agentId: agent.id, agentName: agent.name, round })

      let content: string
      const role = agentRoles[agent.id] ?? 'advisor'
      let imageUrl: string | undefined
      try {
        if (role === 'image_generator') {
          imageUrl = await generateImage(
            agent,
            `${buildSystemPrompt(agent, role)}\n\nCreate an image based on this user request. Follow the visual direction and subject closely; do not add text unless requested.\n\n${input.task}${input.context ? `\n\nConversation context:\n${input.context}` : ''}`,
            signal,
          )
          content = 'Image generated from the boardroom brief.'
        } else {
          content = await complete(
            agent,
            buildSystemPrompt(agent, role),
            `${buildDiscussionPrompt(
              input.task,
              transcript,
              round,
              input.rounds,
              input.context,
            )}${input.imageDataUrl && role === 'image_analyser' ? '\n\nAn image is attached. Analyse the supplied image directly.' : ''}`,
            signal,
            700,
            role,
            role === 'image_analyser' ? input.imageDataUrl : undefined,
          )
        }
      } catch (error) {
        if (signal.aborted) return
        throw new Error(providerErrorMessage(agent.provider, error))
      }

      const turn: BoardroomTurn = {
        id: crypto.randomUUID(),
        agentId: agent.id,
        agentName: agent.name,
        agentRole: `${agent.role} · ${chatRoleLabel(role)}`,
        round,
        content,
        ...(imageUrl ? { imageUrl } : {}),
      }
      transcript.push(turn)
      emit({ type: 'turn_complete', turn })
    }
  }

  if (signal.aborted) return
  const synthesizer =
    selectedSynthesizer ??
    (input.synthesize === false
      ? undefined
      : input.agents.find((agent) => agent.id === input.facilitatorId))
  if (!synthesizer) {
    emit({ type: 'done' })
    return
  }

  emit({
    type: 'synthesis_start',
    agentId: synthesizer.id,
    agentName: synthesizer.name,
  })

  let synthesis: string
  const priorConversation = input.context
    ? `\n\nEarlier conversation:\n${input.context}`
    : ''
  try {
    synthesis = await complete(
      synthesizer,
      `${buildSystemPrompt(synthesizer, 'synthesizer')}\n\nSynthesize the entire discussion into a balanced, decision-ready conclusion. Do not invent consensus; name unresolved disagreements or uncertainty.`,
      `Board task or latest user message:\n${input.task}${priorConversation}\n\nFull discussion:\n${formatTranscript(transcript)}\n\nWrite a concise synthesis with these headings: Conclusion, Key considerations, Recommended next steps. Attribute important viewpoints to the advisor who raised them.`,
      signal,
    )
  } catch (error) {
    if (signal.aborted) return
    throw new Error(providerErrorMessage(synthesizer.provider, error))
  }

  emit({
    type: 'synthesis_complete',
    agentId: synthesizer.id,
    agentName: synthesizer.name,
    content: synthesis,
  })
  emit({ type: 'done' })
}

export function parseDirectorSelection(
  output: string,
  advisors: AgentConfig[],
): AgentConfig | null {
  const selectedId = output.trim()
  return advisors.find((advisor) => advisor.id === selectedId) ?? null
}

export function parseOrchestratorSelection(
  output: string,
  candidates: AgentConfig[],
): AgentConfig[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(output.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''))
  } catch {
    return null
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > 3 ||
    parsed.some((id) => typeof id !== 'string')
  ) {
    return null
  }

  const ids = parsed.filter((id): id is string => typeof id === 'string')
  if (ids.length !== parsed.length) return null
  if (new Set(ids).size !== ids.length) return null
  const selected = ids.map((id) => candidates.find((candidate) => candidate.id === id))
  if (selected.some((agent) => agent === undefined)) return null
  return selected.filter((agent): agent is AgentConfig => agent !== undefined)
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
  const contributors = input.agents.filter(
    (agent) => input.agentRoles?.[agent.id] === 'advisor',
  )
  for (const agent of contributors) {
    if (signal.aborted) return
    emit({ type: 'section_start', agentId: agent.id, agentName: agent.name })

    let content: string
    const role = input.agentRoles?.[agent.id] ?? 'advisor'
    try {
      content = await complete(
        agent,
        `${buildSystemPrompt(agent, role)}\n\nYou are a subject-matter contributor to a professional ${reportTypeLabel(input.type)}. Write only the report sections where your expertise adds value.`,
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
        role,
      )
    } catch (error) {
      if (signal.aborted) return
      throw new Error(providerErrorMessage(agent.provider, error))
    }

    contributions.push({ agent, content })
    emit({ type: 'section_complete', agentId: agent.id, agentName: agent.name })
  }

  if (signal.aborted) return
  const facilitator =
    input.agents.find((agent) => agent.id === input.formatterId) ??
    input.agents.find((agent) => agent.id === input.facilitatorId)!
  const formatterRole: ChatAgentRole = 'report_formatter'
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
      `${buildSystemPrompt(facilitator, formatterRole)}\n\nYou are the report editor${input.formatterId ? ' and designated report formatter' : ' and boardroom facilitator'}. Produce a complete, professional document from the advisor contributions. Follow the formatting and company-style rules in your agent profile. Preserve all facts and conclusions, keep role-specific expertise visible, reconcile differences transparently, and do not invent facts or consensus.`,
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
      formatterRole,
    )
  } catch (error) {
    if (signal.aborted) return
    throw new Error(providerErrorMessage(facilitator.provider, error))
  }

  emit({ type: 'report_complete', content })
  emit({ type: 'done' })
}
