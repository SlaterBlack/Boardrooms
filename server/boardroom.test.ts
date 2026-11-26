import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import type { AgentConfig } from '../shared/boardroom.ts'
import {
  BoardroomInputError,
  parseBoardroomInput,
  parseDirectorSelection,
  parseOrchestratorSelection,
  parseBoardroomReportInput,
  runBoardroom,
} from './boardroom.ts'

const agent: AgentConfig = {
  id: 'strategy',
  name: 'Strategy',
  role: 'Market analyst',
  provider: 'openai',
  model: 'gpt-6.2-sol',
  knowledge: '',
  skills: '',
  instructions: '',
}
const orchestrator = { ...agent, id: 'orchestrator', name: 'Orchestrator' }
const boardroomAgents = [orchestrator, agent]

test('parses a boardroom request and supplies the default Orchestrator and rounds', () => {
  const input = parseBoardroomInput({
    meetingId: 'meeting-123',
    task: 'Review the launch plan',
    agents: boardroomAgents,
  })

  assert.equal(input.meetingId, 'meeting-123')
  assert.equal(input.rounds, 2)
  assert.equal(input.facilitatorId, agent.id)
  assert.equal(input.agentRoles?.[orchestrator.id], 'director')
  assert.equal(input.agents[1].provider, 'openai')
})

test('streams Anthropic advisor and synthesis deltas before their completed events', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const events = [
      ['message_start', {
        type: 'message_start',
        message: {
          id: 'msg-test',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }],
      ['content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }],
      ['content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Streamed ' },
      }],
      ['content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'answer.' },
      }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      }],
      ['message_stop', { type: 'message_stop' }],
    ] as const
    for (const [name, data] of events) {
      response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const previousApiKey = process.env.ANTHROPIC_API_KEY
  const previousBaseUrl = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_API_KEY = 'streaming-test-key'
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${address.port}`

  try {
    const events: import('../shared/boardroom.ts').BoardroomEvent[] = []
    await runBoardroom(
      {
        task: 'Give a short answer.',
        agents: [
          { ...orchestrator, provider: 'anthropic' },
          { ...agent, provider: 'anthropic' },
        ],
        rounds: 1,
        facilitatorId: agent.id,
        directAgentId: agent.id,
        synthesize: true,
        agentRoles: { orchestrator: 'director', strategy: 'advisor' },
      },
      (event) => events.push(event),
      new AbortController().signal,
    )

    const turnDeltas = events.filter((event) => event.type === 'turn_delta')
    const synthesisDeltas = events.filter((event) => event.type === 'synthesis_delta')
    assert.equal(
      turnDeltas
        .map((event) => event.type === 'turn_delta' ? event.delta : '')
        .join(''),
      'Streamed answer.',
    )
    assert.equal(
      synthesisDeltas
        .map((event) => event.type === 'synthesis_delta' ? event.delta : '')
        .join(''),
      'Streamed answer.',
    )
    assert.equal(
      events.filter((event) => event.type === 'turn_complete').length,
      1,
    )
    assert.equal(
      events.filter((event) => event.type === 'synthesis_complete').length,
      1,
    )
    assert.equal(events.at(-1)?.type, 'done')
  } finally {
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = previousBaseUrl
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test('streams Gemini advisor and synthesis deltas', async () => {
  const originalFetch = globalThis.fetch
  const previousApiKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'gemini-streaming-test-key'
  globalThis.fetch = async () =>
    new Response([
      `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini ' }] } }] })}\n\n`,
      `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'streamed.' }] } }] })}\n\n`,
    ].join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })

  try {
    const events: import('../shared/boardroom.ts').BoardroomEvent[] = []
    await runBoardroom(
      {
        task: 'Give a short answer.',
        agents: [
          { ...orchestrator, provider: 'gemini' },
          { ...agent, provider: 'gemini', model: 'gemini-4-hydrogen' },
        ],
        rounds: 1,
        facilitatorId: agent.id,
        directAgentId: agent.id,
        synthesize: true,
        agentRoles: { orchestrator: 'director', strategy: 'advisor' },
      },
      (event) => events.push(event),
      new AbortController().signal,
    )

    const deltas = events.filter((event) => event.type === 'turn_delta')
    const synthesisDeltas = events.filter((event) => event.type === 'synthesis_delta')
    assert.equal(
      deltas
        .map((event) => event.type === 'turn_delta' ? event.delta : '')
        .join(''),
      'Gemini streamed.',
    )
    assert.equal(
      synthesisDeltas
        .map((event) => event.type === 'synthesis_delta' ? event.delta : '')
        .join(''),
      'Gemini streamed.',
    )
    assert.equal(events.at(-1)?.type, 'done')
  } finally {
    globalThis.fetch = originalFetch
    if (previousApiKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = previousApiKey
  }
})

test('uses the OpenRouter Decisions API for Gemini Decision 1 Orchestrator routing', async () => {
  const originalFetch = globalThis.fetch
  const previousApiKey = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = 'decision-routing-test-key'
  let requestUrl = ''
  const requestBodies: Record<string, unknown>[] = []
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input)
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(JSON.stringify({
      answers: {
        agent_0: { type: 'choice', choice: 'advisor', confidence: 0.92 },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const controller = new AbortController()
  const events: import('../shared/boardroom.ts').BoardroomEvent[] = []
  try {
    await runBoardroom(
      {
        task: 'Compare the options and recommend a decision.',
        agents: [
          {
            ...orchestrator,
            provider: 'openrouter',
            model: 'google/gemini-decision-1',
            modelCapabilities: { supportsDecisionRouting: true },
          },
          agent,
        ],
        rounds: 1,
        facilitatorId: agent.id,
        synthesize: false,
        agentRoles: { orchestrator: 'director', strategy: 'advisor' },
      },
      (event) => {
        events.push(event)
        if (event.type === 'route_complete') controller.abort()
      },
      controller.signal,
    )

    assert.equal(requestUrl, 'https://openrouter.ai/api/alpha/decisions')
    assert.equal(requestBodies[0]?.model, 'google/gemini-decision-1')
    assert.equal(events.some((event) => event.type === 'route_complete'), true)
    assert.deepEqual(
      events
        .filter((event) => event.type === 'route_complete')
        .map((event) => event.type === 'route_complete' ? event.agentId : ''),
      [agent.id],
    )
  } finally {
    globalThis.fetch = originalFetch
    if (previousApiKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousApiKey
  }
})

test('accepts bounded prior conversation context for chat turns', () => {
  const context = 'User: What should we consider?'
  const input = parseBoardroomInput({
    task: 'How should we proceed?',
    context,
    rounds: 1,
    agents: boardroomAgents,
  })

  assert.equal(input.context, context)
  assert.equal(input.rounds, 1)
  assert.equal(input.synthesize, true)
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Continue the discussion',
        context: 'x'.repeat(24_001),
        agents: boardroomAgents,
      }),
    /Conversation context/,
  )
})

test('accepts Gemini agents and model IDs in boardroom requests', () => {
  const input = parseBoardroomInput({
    task: 'Review the launch plan',
    agents: [
      { ...orchestrator, provider: 'gemini', model: 'gemini-4-hydrogen' },
      { ...agent, provider: 'gemini', model: 'gemini-4-hydrogen' },
    ],
  })

  assert.equal(input.agents[0].provider, 'gemini')
  assert.equal(input.agents[1].model, 'gemini-4-hydrogen')
})

test('allows Gemini Decision 1 only as an Orchestrator, not a responding agent', () => {
  const decisionAgent = {
    ...orchestrator,
    id: 'decision-router',
    name: 'Decision Router',
    provider: 'openrouter' as const,
    model: 'google/gemini-decision-1',
    modelCapabilities: { supportsDecisionRouting: true },
  }
  const input = parseBoardroomInput({
    task: 'Choose a recommended plan.',
    agents: [decisionAgent, agent],
    agentRoles: {
      'decision-router': 'director',
      strategy: 'advisor',
    },
  })
  assert.equal(input.agents[0].model, 'google/gemini-decision-1')
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Choose a recommended plan.',
        directAgentId: decisionAgent.id,
        agents: [orchestrator, agent, decisionAgent],
        agentRoles: {
          orchestrator: 'director',
          strategy: 'advisor',
          'decision-router': 'advisor',
        },
      }),
    /responding agent/,
  )
})

test('allows informational chat requests to skip facilitator synthesis', () => {
  const input = parseBoardroomInput({
    task: 'Assess the low-carbon options',
    rounds: 1,
    synthesize: false,
    agents: boardroomAgents,
  })

  assert.equal(input.synthesize, false)
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Assess the low-carbon options',
        synthesize: 'false',
        agents: boardroomAgents,
      }),
    /Synthesize must be a boolean/,
  )
})

test('accepts a director and validates one routed advisor role', () => {
  const director = { ...agent, id: 'director', name: 'Director' }
  const input = parseBoardroomInput({
    task: 'Review the facade options',
    agents: [director, agent],
    agentRoles: {
      director: 'director',
      strategy: 'advisor',
    },
    facilitatorId: agent.id,
  })
  assert.equal(input.agentRoles?.director, 'director')
  assert.equal(input.agentRoles?.strategy, 'advisor')
  assert.equal(parseDirectorSelection(agent.id, [agent]), agent)
  assert.equal(parseDirectorSelection(`${agent.id} sounds best`, [agent]), null)
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Review the facade options',
        agents: [director, agent],
        agentRoles: {
          director: 'director',
          strategy: 'director',
        },
        facilitatorId: agent.id,
      }),
    /exactly one Orchestrator/,
  )
})

test('parses an Orchestrator sequence of up to three eligible agents', () => {
  const agents = [
    agent,
    {
      ...agent,
      id: 'researcher',
      name: 'Researcher',
      modelCapabilities: { supportsWebSearch: true },
    },
    { ...agent, id: 'critic', name: 'Critic' },
    { ...agent, id: 'other', name: 'Other' },
  ]

  assert.deepEqual(
    parseOrchestratorSelection(
      '[{"agentId":"researcher","role":"researcher"},{"agentId":"strategy","role":"advisor"},{"agentId":"critic","role":"critic"}]',
      agents,
    ),
    [
      { agent: agents[1], role: 'researcher' },
      { agent: agents[0], role: 'advisor' },
      { agent: agents[2], role: 'critic' },
    ],
  )
  assert.equal(parseOrchestratorSelection('[{"agentId":"strategy","role":"advisor"},{"agentId":"missing","role":"advisor"}]', agents), null)
  assert.equal(parseOrchestratorSelection('[{"agentId":"strategy","role":"advisor"},{"agentId":"strategy","role":"critic"}]', agents), null)
  assert.equal(
    parseOrchestratorSelection('["strategy","researcher","critic","other"]', agents),
    null,
  )
})

test('validates dynamic roles against agent capabilities and allows only one image generator', () => {
  const generator = {
    ...agent,
    id: 'generator',
    modelCapabilities: { supportsImageGeneration: true },
  }
  const webAgent = {
    ...agent,
    id: 'web-agent',
    modelCapabilities: { supportsWebSearch: true },
  }
  const candidates = [agent, generator, webAgent]

  assert.deepEqual(
    parseOrchestratorSelection(
      '[{"agentId":"generator","role":"image_generator"}]',
      candidates,
    ),
    [{ agent: generator, role: 'image_generator' }],
  )
  assert.equal(
    parseOrchestratorSelection(
      '[{"agentId":"strategy","role":"researcher"}]',
      candidates,
    ),
    null,
  )
  assert.equal(
    parseOrchestratorSelection(
      '[{"agentId":"generator","role":"image_generator"},{"agentId":"web-agent","role":"image_generator"}]',
      candidates,
    ),
    null,
  )
  assert.equal(
    parseOrchestratorSelection(
      '[{"agentId":"strategy","role":"image_analyser"}]',
      candidates,
    ),
    null,
  )
  assert.equal(
    parseOrchestratorSelection(
      '[{"agentId":"strategy","role":"synthesizer"}]',
      candidates,
      false,
      false,
    ),
    null,
  )
})

test('allows an explicit direct route without persisting a specialist role', () => {
  const imageGenerator = {
    ...agent,
    id: 'image-generator',
    name: 'Image Generator',
    model: 'gpt-image-1',
    modelCapabilities: { supportsImageGeneration: true },
  }
  const input = parseBoardroomInput({
    task: 'Create a timber pavilion concept image.',
    agents: [orchestrator, agent, imageGenerator],
    agentRoles: {
      orchestrator: 'director',
      strategy: 'advisor',
      'image-generator': 'advisor',
    },
    facilitatorId: agent.id,
    directAgentId: imageGenerator.id,
  })

  assert.equal(input.directAgentId, imageGenerator.id)
  assert.equal(input.agentRoles?.[imageGenerator.id], 'advisor')
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Route this request.',
        agents: [agent, { ...agent, id: 'director' }],
        agentRoles: { strategy: 'advisor', director: 'director' },
        facilitatorId: agent.id,
        directAgentId: 'director',
      }),
    /Choose a responding agent/,
  )
})

test('accepts image attachments with any selected vision-capable agent', () => {
  const visionAgent: AgentConfig = {
    ...agent,
    id: 'vision-agent',
    name: 'Vision Agent',
    modelCapabilities: { supportsVision: true },
  }
  const input = parseBoardroomInput({
    task: 'Review this facade.',
    imageDataUrl: 'data:image/png;base64,dGVzdA==',
    agents: [orchestrator, agent, visionAgent],
    facilitatorId: agent.id,
  })

  assert.equal(input.imageDataUrl, 'data:image/png;base64,dGVzdA==')
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Review this facade.',
        imageDataUrl: 'data:image/png;base64,dGVzdA==',
        agents: [orchestrator, agent],
      }),
    /agent whose model supports image input/,
  )
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Review this facade.',
        imageDataUrl: 'data:image/png;base64,dGVzdA==',
        agents: [orchestrator, agent, visionAgent],
        directAgentId: agent.id,
      }),
    /cannot inspect attached images/,
  )
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Review this facade.',
        imageDataUrl: 'data:image/png;base64,dGVzdA===',
        agents: [orchestrator, agent, visionAgent],
        facilitatorId: agent.id,
      }),
    /PNG, JPEG, or WebP/,
  )
})

test('parses report jobs and validates document type, title, and context', () => {
  const input = parseBoardroomReportInput({
    type: 'scope',
    title: 'Community centre scope',
    instructions: 'Include accessibility and sustainability.',
    context: 'The board concluded that the centre should use a timber structure.',
    agents: boardroomAgents,
  })

  assert.equal(input.type, 'scope')
  assert.equal(input.title, 'Community centre scope')
  assert.equal(input.facilitatorId, agent.id)

  assert.throws(
    () =>
      parseBoardroomReportInput({
        type: 'proposal',
        title: 'Invalid report',
        context: 'Some context',
        agents: boardroomAgents,
      }),
    /report type/,
  )
  assert.throws(
    () =>
      parseBoardroomReportInput({
        type: 'review',
        title: '   ',
        context: 'Some context',
        agents: [agent],
      }),
    /Report title/,
  )
})

test('normalizes legacy formatter assignments to meeting members', () => {
  const formatter = { ...agent, id: 'formatter', name: 'Formatter' }
  const input = parseBoardroomReportInput({
    type: 'custom',
    title: 'Client report',
    context: 'The board agreed to preserve the existing courtyard.',
    agents: [orchestrator, agent, formatter],
    facilitatorId: agent.id,
    agentRoles: {
      orchestrator: 'director',
      strategy: 'advisor',
      formatter: 'report_formatter',
    },
  })

  assert.equal(input.agentRoles?.[formatter.id], 'advisor')
})

test('accepts OpenRouter provider-prefixed model IDs', () => {
  const input = parseBoardroomInput({
    task: 'Review the launch plan',
    agents: [
      orchestrator,
      { ...agent, provider: 'openrouter', model: 'openai/gpt-4o-mini' },
    ],
  })

  assert.equal(input.agents[1].provider, 'openrouter')
  assert.equal(input.agents[1].model, 'openai/gpt-4o-mini')
})

test('rejects empty tasks and empty agent lists', () => {
  assert.throws(
    () => parseBoardroomInput({ task: ' ', agents: [agent] }),
    BoardroomInputError,
  )
  assert.throws(
    () => parseBoardroomInput({ task: 'Review the launch plan', agents: [] }),
    BoardroomInputError,
  )
})

test('rejects invalid provider, model, and facilitator values', () => {
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Review the launch plan',
        agents: [orchestrator, { ...agent, provider: 'unknown' }],
      }),
    /unsupported provider/,
  )
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Review the launch plan',
        agents: [orchestrator, { ...agent, model: 'model name with spaces' }],
      }),
    /invalid model ID/,
  )
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Review the launch plan',
        agents: [
          orchestrator,
          { ...agent, provider: 'openrouter', model: 'model name with spaces' },
        ],
      }),
    /invalid model ID/,
  )
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Review the launch plan',
        agents: boardroomAgents,
        facilitatorId: 'missing',
      }),
    /facilitator/,
  )
})
