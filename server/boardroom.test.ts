import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BoardroomInputError,
  parseBoardroomInput,
  parseBoardroomReportInput,
} from './boardroom.ts'

const agent = {
  id: 'strategy',
  name: 'Strategy',
  role: 'Market analyst',
  provider: 'openai',
  model: 'gpt-6.2-sol',
  knowledge: '',
  skills: '',
  instructions: '',
}

test('parses a boardroom request and supplies the default facilitator and rounds', () => {
  const input = parseBoardroomInput({ task: 'Review the launch plan', agents: [agent] })

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
