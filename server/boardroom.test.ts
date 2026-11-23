import assert from 'node:assert/strict'
import test from 'node:test'
import { BoardroomInputError, parseBoardroomInput } from './boardroom.ts'

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
        agents: [agent],
        facilitatorId: 'missing',
      }),
    /facilitator/,
  )
})
