import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MagnificInputError,
  generateWithMagnific,
  parseMagnificUpscaleInput,
  upscaleWithMagnific,
} from './magnific.ts'

test('validates Magnific image uploads and processing options', () => {
  assert.deepEqual(
    parseMagnificUpscaleInput({
      image: 'data:image/png;base64,dGVzdA==',
      scaleFactor: 4,
      flavor: 'sublime',
    }),
    {
      image: 'dGVzdA==',
      scaleFactor: 4,
      flavor: 'sublime',
    },
  )

  assert.throws(
    () => parseMagnificUpscaleInput({ image: 'https://example.com/image.png' }),
    MagnificInputError,
  )
  assert.throws(
    () =>
      parseMagnificUpscaleInput({
        image: 'data:image/png;base64,dGVzdA==',
        scaleFactor: 3,
      }),
    /scale of 2x, 4x, 8x, or 16x/,
  )
})

test('creates and polls a Magnific Mystic image generation task', async () => {
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.MAGNIFIC_API_KEY
  process.env.MAGNIFIC_API_KEY = 'test-magnific-key'
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    if (init?.method === 'POST') {
      return Response.json({ data: { task_id: 'mystic-123', status: 'IN_PROGRESS' } })
    }
    return Response.json({
      data: {
        task_id: 'mystic-123',
        status: 'COMPLETED',
        generated: ['https://images.magnific.com/generated.png'],
      },
    })
  }

  try {
    const imageUrl = await generateWithMagnific(
      { model: 'mystic:realism', prompt: 'A timber community centre' },
      new AbortController().signal,
      { pollIntervalMs: 0 },
    )

    assert.equal(imageUrl, 'https://images.magnific.com/generated.png')
    assert.equal(requests.length, 2)
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
      prompt: 'A timber community centre',
      model: 'realism',
      resolution: '1k',
      aspect_ratio: 'square_1_1',
    })
    assert.match(requests[1].url, /mystic-123$/)
  } finally {
    globalThis.fetch = originalFetch
    if (originalApiKey === undefined) delete process.env.MAGNIFIC_API_KEY
    else process.env.MAGNIFIC_API_KEY = originalApiKey
  }
})

test('creates and polls a Magnific upscaling task with the server API key', async () => {
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.MAGNIFIC_API_KEY
  process.env.MAGNIFIC_API_KEY = 'test-magnific-key'
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    if (init?.method === 'POST') {
      return Response.json({ data: { task_id: 'task-123', status: 'IN_PROGRESS' } })
    }
    return Response.json({
      data: {
        task_id: 'task-123',
        status: 'COMPLETED',
        generated: ['https://images.magnific.com/upscaled.png'],
      },
    })
  }

  try {
    const imageUrl = await upscaleWithMagnific(
      {
        image: 'dGVzdA==',
        scaleFactor: 2,
        flavor: 'photo',
      },
      new AbortController().signal,
      { pollIntervalMs: 0 },
    )

    assert.equal(imageUrl, 'https://images.magnific.com/upscaled.png')
    assert.equal(requests.length, 2)
    assert.equal(
      new Headers(requests[0].init?.headers).get('x-magnific-api-key'),
      'test-magnific-key',
    )
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
      image: 'dGVzdA==',
      scale_factor: 2,
      flavor: 'photo',
    })
    assert.match(requests[1].url, /task-123$/)
  } finally {
    globalThis.fetch = originalFetch
    if (originalApiKey === undefined) delete process.env.MAGNIFIC_API_KEY
    else process.env.MAGNIFIC_API_KEY = originalApiKey
  }
})
