import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentConfig, ChatAgentRole } from '../shared/boardroom.ts'
import {
  normalizeChatAgentRoles,
  resolveAdvisorMention,
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
  const mention = resolveAdvisorMention(
    '@{Bonnie Green} assess the low-carbon options',
    [bonnie, clyde],
  )

  assert.equal(mention?.agent.id, bonnie.id)
  assert.equal(mention?.prompt, 'assess the low-carbon options')
})

test('resolves unbraced advisor mentions and supplies a prompt when empty', () => {
  const mention = resolveAdvisorMention('@Clyde', [bonnie, clyde])

  assert.equal(mention?.agent.id, clyde.id)
  assert.equal(mention?.prompt, 'Please respond to the conversation so far.')
})

test('does not resolve mentions that are not at the start or name no advisor', () => {
  assert.equal(resolveAdvisorMention('Ask @Clyde about cost', [bonnie, clyde]), null)
  assert.equal(resolveAdvisorMention('@Unknown advise me', [bonnie, clyde]), null)
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
