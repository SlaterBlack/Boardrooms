import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  importBoardroomState,
  parseBoardroomStatePatch,
  recoverInterruptedMeetings,
  readBoardroomState,
  updateBoardroomState,
} from './state.ts'

const agent = {
  id: 'strategy',
  name: 'Strategy',
  role: 'Market analyst',
  defaultChatRole: 'advisor' as const,
  modelCapabilities: {},
  provider: 'openai' as const,
  model: 'gpt-6.2-sol',
  knowledge: '',
  skills: '',
  instructions: '',
}
const formatter = { ...agent, id: 'formatter', name: 'Report formatter' }

const meeting = {
  id: 'launch-review',
  name: 'Launch review',
  task: 'Review the launch plan',
  agents: [agent],
  facilitatorId: agent.id,
  rounds: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'ready' as const,
  mode: 'discussion' as const,
  chatType: 'informational' as const,
  agentRoles: { strategy: 'advisor' as const },
  transcript: [],
  chatMessages: [],
  reports: [],
  synthesis: '',
  error: '',
}

test('persists shared boardroom state and merges legacy imports without overwriting server records', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boardrooms-state-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'state.json')

  assert.equal(await readBoardroomState(filePath), null)
  const imported = await importBoardroomState(
    {
      agents: [agent],
      meetings: [
        {
          ...meeting,
          agents: [{ ...agent, provider: 'openrouter' as const, model: 'example/model:free' }],
        },
      ],
    },
    filePath,
  )
  assert.equal(imported.revision, 1)
  assert.equal(imported.meetings[0].agents[0].provider, 'openai')
  assert.equal(imported.meetings[0].agents[0].model, 'gpt-6.2-sol')

  const secondImport = await importBoardroomState(
    {
      agents: [
        { ...agent, name: 'Outdated local copy' },
        { ...agent, id: 'bonnie', name: 'Bonnie' },
      ],
      meetings: [],
    },
    filePath,
  )
  assert.equal(secondImport.revision, 2)
  assert.equal(secondImport.agents[0].name, 'Strategy')
  assert.equal(secondImport.agents[1].name, 'Bonnie')

  const updated = await updateBoardroomState(
    { agents: [{ ...agent, name: 'Updated strategy' }] },
    filePath,
  )
  assert.equal(updated.revision, 3)
  assert.equal(updated.agents[0].name, 'Updated strategy')
  assert.equal(updated.meetings[0].id, meeting.id)
  assert.equal(updated.meetings[0].agents[0].name, 'Strategy')
  assert.deepEqual(await readBoardroomState(filePath), updated)
})

test('rejects invalid boardroom state patches', () => {
  assert.throws(
    () => parseBoardroomStatePatch({ agents: [{ id: 'invalid' }] }),
    /Agents contains an invalid entry/,
  )
  assert.throws(() => parseBoardroomStatePatch({}), /Provide agents or meetings/)
})

test('validates chat messages and upgrades legacy meetings to structured discussions', () => {
  const legacy = parseBoardroomStatePatch({
    meetings: [
      { ...meeting, mode: undefined, agentRoles: undefined, chatMessages: undefined },
    ],
  })
  assert.equal(legacy.meetings?.[0].mode, 'discussion')
  assert.equal(legacy.meetings?.[0].chatType, 'informational')
  assert.equal(legacy.meetings?.[0].agentRoles.strategy, 'advisor')
  assert.deepEqual(legacy.meetings?.[0].chatMessages, [])
  assert.deepEqual(legacy.meetings?.[0].reports, [])

  const legacyChat = parseBoardroomStatePatch({
    meetings: [
      { ...meeting, mode: 'chat', chatType: undefined, agentRoles: undefined },
    ],
  })
  assert.equal(legacyChat.meetings?.[0].chatType, 'document')

  const chat = parseBoardroomStatePatch({
    meetings: [
      {
        ...meeting,
        mode: 'chat',
        agentRoles: { strategy: 'advisor' },
        chatMessages: [
          {
            id: 'user-1',
            role: 'user',
            content: 'How can we improve this design?',
            createdAt: '2026-01-01T00:01:00.000Z',
          },
          {
            id: 'advisor-1',
            role: 'agent',
            content: 'Consider daylight and circulation.',
            createdAt: '2026-01-01T00:02:00.000Z',
            agentId: agent.id,
            agentName: agent.name,
            agentRole: agent.role,
            imageUrl: 'https://images.magnific.com/upscaled.png',
          },
        ],
        reports: [
          {
            id: 'report-1',
            title: 'Design review',
            type: 'review',
            content: '# Design review\n\n## Recommendations',
            createdAt: '2026-01-01T00:03:00.000Z',
          },
        ],
      },
    ],
  })
  assert.equal(chat.meetings?.[0].mode, 'chat')
  assert.equal(chat.meetings?.[0].chatMessages.length, 2)
  assert.equal(
    chat.meetings?.[0].chatMessages[1].imageUrl,
    'https://images.magnific.com/upscaled.png',
  )
  assert.equal(chat.meetings?.[0].reports[0].type, 'review')

  const formattedChat = parseBoardroomStatePatch({
    meetings: [
      {
        ...meeting,
        mode: 'chat',
        agents: [agent, formatter],
        agentRoles: {
          strategy: 'advisor',
          formatter: 'report_formatter',
        },
      },
    ],
  })
  assert.equal(
    formattedChat.meetings?.[0].agentRoles.formatter,
    'report_formatter',
  )

  assert.throws(
    () =>
      parseBoardroomStatePatch({
        meetings: [
          {
            ...meeting,
            mode: 'chat',
            chatMessages: [{ id: 'bad', role: 'system', content: 'bad', createdAt: '' }],
          },
        ],
      }),
    /Meetings contains an invalid entry/,
  )
  assert.throws(
      () =>
        parseBoardroomStatePatch({
          meetings: [{ ...meeting, chatType: 'unknown' }],
        }),
      /Meetings contains an invalid entry/,
  )
  assert.throws(
      () =>
        parseBoardroomStatePatch({
          meetings: [
            {
              ...meeting,
              agentRoles: { strategy: 'director' },
            },
          ],
        }),
      /Meetings contains an invalid entry/,
  )
})

test('marks discussions interrupted after a server restart', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boardrooms-state-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'state.json')

  await importBoardroomState(
    {
      agents: [agent],
      meetings: [
        {
          ...meeting,
          agents: [{ ...agent, provider: 'openrouter' as const, model: 'example/model:free' }],
          status: 'running',
        },
      ],
    },
    filePath,
  )

  const recovered = await recoverInterruptedMeetings(filePath)
  assert.equal(recovered?.meetings[0].status, 'interrupted')
  assert.equal(recovered?.meetings[0].agents[0].provider, 'openai')
  assert.equal(
    recovered?.meetings[0].error,
    'The server restarted before this discussion completed.',
  )
})
