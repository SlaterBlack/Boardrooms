import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentConfig } from '../shared/boardroom.ts'
import {
  BoardroomInputError,
  parseBoardroomInput,
  parseDirectorSelection,
  parseOrchestratorSelection,
  parseBoardroomReportInput,
} from './boardroom.ts'

const agent: AgentConfig = {
  id: 'strategy',
  name: 'Strategy',
  role: 'Market analyst',
  defaultChatRole: 'advisor',
  provider: 'openai',
  model: 'gpt-6.2-sol',
  knowledge: '',
  skills: '',
  instructions: '',
}

test('parses a boardroom request and supplies the default facilitator and rounds', () => {
  const input = parseBoardroomInput({
    meetingId: 'meeting-123',
    task: 'Review the launch plan',
    agents: [agent],
  })

  assert.equal(input.meetingId, 'meeting-123')
  assert.equal(input.rounds, 2)
  assert.equal(input.facilitatorId, 'strategy')
  assert.equal(input.agents[0].provider, 'openai')
})

test('accepts bounded prior conversation context for chat turns', () => {
  const context = 'User: What should we consider?'
  const input = parseBoardroomInput({
    task: 'How should we proceed?',
    context,
    rounds: 1,
    agents: [agent],
  })

  assert.equal(input.context, context)
  assert.equal(input.rounds, 1)
  assert.equal(input.synthesize, true)
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Continue the discussion',
        context: 'x'.repeat(24_001),
        agents: [agent],
      }),
    /Conversation context/,
  )
})

test('allows informational chat requests to skip facilitator synthesis', () => {
  const input = parseBoardroomInput({
    task: 'Assess the low-carbon options',
    rounds: 1,
    synthesize: false,
    agents: [agent],
  })

  assert.equal(input.synthesize, false)
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Assess the low-carbon options',
        synthesize: 'false',
        agents: [agent],
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
    /at least one Meeting Member/,
  )
})

test('parses an Orchestrator sequence of up to three eligible agents', () => {
  const agents = [
    agent,
    { ...agent, id: 'researcher', name: 'Researcher' },
    { ...agent, id: 'critic', name: 'Critic' },
    { ...agent, id: 'other', name: 'Other' },
  ]

  assert.deepEqual(
    parseOrchestratorSelection('["researcher","strategy","critic"]', agents),
    [agents[1], agents[0], agents[2]],
  )
  assert.equal(parseOrchestratorSelection('["strategy","missing"]', agents), null)
  assert.equal(parseOrchestratorSelection('["strategy","strategy"]', agents), null)
  assert.equal(
    parseOrchestratorSelection('["strategy","researcher","critic","other"]', agents),
    null,
  )
})

test('allows an explicit direct route to a specialist without changing its role', () => {
  const imageGenerator = {
    ...agent,
    id: 'image-generator',
    name: 'Image Generator',
    model: 'gpt-image-1',
    modelCapabilities: { supportsImageGeneration: true },
  }
  const input = parseBoardroomInput({
    task: 'Create a timber pavilion concept image.',
    agents: [agent, imageGenerator],
    agentRoles: {
      strategy: 'advisor',
      'image-generator': 'image_generator',
    },
    facilitatorId: agent.id,
    directAgentId: imageGenerator.id,
  })

  assert.equal(input.directAgentId, imageGenerator.id)
  assert.equal(input.agentRoles?.[imageGenerator.id], 'image_generator')
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

test('requires a capable Image Analyser for a valid bounded image attachment', () => {
  const analyser: AgentConfig = {
    ...agent,
    id: 'analyser',
    name: 'Image Analyser',
    modelCapabilities: { supportsVision: true },
  }
  const input = parseBoardroomInput({
    task: 'Review this facade.',
    imageDataUrl: 'data:image/png;base64,dGVzdA==',
    agents: [agent, analyser],
    agentRoles: { strategy: 'advisor', analyser: 'image_analyser' },
    facilitatorId: agent.id,
  })

  assert.equal(input.imageDataUrl, 'data:image/png;base64,dGVzdA==')
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Review this facade.',
        imageDataUrl: 'data:image/png;base64,dGVzdA==',
        agents: [agent],
      }),
    /Add an Image Analyser/,
  )
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Review this facade.',
        imageDataUrl: 'data:image/png;base64,dGVzdA===',
        agents: [agent, analyser],
        agentRoles: { strategy: 'advisor', analyser: 'image_analyser' },
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
    agents: [agent],
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
        agents: [agent],
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

test('selects a chat-assigned report formatter for the final report pass', () => {
  const formatter = { ...agent, id: 'formatter', name: 'Formatter' }
  const input = parseBoardroomReportInput({
    type: 'custom',
    title: 'Client report',
    context: 'The board agreed to preserve the existing courtyard.',
    agents: [agent, formatter],
    facilitatorId: agent.id,
    agentRoles: {
      strategy: 'advisor',
      formatter: 'report_formatter',
    },
  })

  assert.equal(input.formatterId, formatter.id)
  assert.equal(input.agentRoles?.[formatter.id], 'report_formatter')
})

test('accepts OpenRouter provider-prefixed model IDs', () => {
  const input = parseBoardroomInput({
    task: 'Review the launch plan',
    agents: [{ ...agent, provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
  })

  assert.equal(input.agents[0].provider, 'openrouter')
  assert.equal(input.agents[0].model, 'openai/gpt-4o-mini')
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
        agents: [{ ...agent, provider: 'unknown' }],
      }),
    /unsupported provider/,
  )
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Review the launch plan',
        agents: [{ ...agent, model: 'model name with spaces' }],
      }),
    /invalid model ID/,
  )
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Review the launch plan',
        agents: [{ ...agent, provider: 'openrouter', model: 'model name with spaces' }],
      }),
    /invalid model ID/,
  )
  assert.throws(
    () =>
      parseBoardroomInput({
        task: 'Review the launch plan',
        agents: [agent],
        facilitatorId: 'missing',
      }),
    /facilitator/,
  )
})
