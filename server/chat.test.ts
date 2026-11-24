import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentConfig, ChatAgentRole } from '../shared/boardroom.ts'
import {
  normalizeChatAgentRoles,
  resolveAgentMention,
} from '../shared/chat.ts'

const bonnie: AgentConfig = {
  id: 'bonnie',
  name: 'Bonnie Green',
  role: 'Environment-focused architect',
  defaultChatRole: 'advisor',
  provider: 'openai',
  model: 'gpt-test',
  knowledge: '',
  skills: '',
  instructions: '',
}

const clyde: AgentConfig = {
  ...bonnie,
  id: 'clyde',
  name: 'Clyde',
  role: 'Finance-focused architect',
}

test('resolves braced advisor mentions with names containing spaces', () => {
  const mention = resolveAgentMention(
    '@{Bonnie Green} assess the low-carbon options',
    [bonnie, clyde],
  )

  assert.equal(mention?.agent.id, bonnie.id)
  assert.equal(mention?.prompt, 'assess the low-carbon options')
})

test('resolves unbraced advisor mentions and supplies a prompt when empty', () => {
  const mention = resolveAgentMention('@Clyde', [bonnie, clyde])

  assert.equal(mention?.agent.id, clyde.id)
  assert.equal(mention?.prompt, 'Please respond to the conversation so far.')
})

test('resolves mentions within a message and ignores unknown advisor names', () => {
  const inlineMention = resolveAgentMention(
    'Can you ask @{Bonnie Green} about the low-carbon options?',
    [bonnie, clyde],
  )

  assert.equal(inlineMention?.agent.id, bonnie.id)
  assert.equal(inlineMention?.prompt, 'Can you ask about the low-carbon options?')
  assert.equal(resolveAgentMention('@Unknown advise me', [bonnie, clyde]), null)
})

test('resolves a specialist agent mention', () => {
  const imageGenerator: AgentConfig = {
    ...bonnie,
    id: 'image-generator',
    name: 'Image Generator',
    defaultChatRole: 'image_generator',
    modelCapabilities: { supportsImageGeneration: true },
  }
  const mention = resolveAgentMention(
    '@{Image Generator} create a timber pavilion concept',
    [imageGenerator],
  )

  assert.equal(mention?.agent.id, imageGenerator.id)
  assert.equal(mention?.prompt, 'create a timber pavilion concept')
})

test('normalizes legacy advisor roles and rejects duplicate or missing advisor assignments', () => {
  assert.deepEqual(normalizeChatAgentRoles(['bonnie', 'clyde'], undefined), {
    bonnie: 'advisor',
    clyde: 'advisor',
  })

  const roles: Record<string, ChatAgentRole> = {
    bonnie: 'director',
    clyde: 'advisor',
  }
  assert.deepEqual(normalizeChatAgentRoles(['bonnie', 'clyde'], roles), roles)
  assert.equal(
    normalizeChatAgentRoles(['bonnie', 'clyde'], {
      bonnie: 'director',
      clyde: 'director',
    }),
    null,
  )
  assert.equal(
    normalizeChatAgentRoles(['bonnie'], { bonnie: 'report_formatter' }),
    null,
  )
})
