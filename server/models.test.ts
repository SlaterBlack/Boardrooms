import assert from 'node:assert/strict'
import test from 'node:test'
import {
  listProviderModels,
  normalizeProviderModels,
  ProviderModelsError,
  requireProviderApiKey,
} from './models.ts'

test('requires a valid provider key to list OpenAI, Anthropic, and Gemini models', () => {
  for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
    assert.throws(
      () => requireProviderApiKey(provider, {}),
      (error: unknown) =>
        error instanceof ProviderModelsError &&
        error.message === 'API key invalid' &&
        error.statusCode === 401,
    )
  }
})

test('discovers Gemini generation, vision, image generation, and search capabilities', async () => {
  const originalFetch = globalThis.fetch
  const previousApiKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'gemini-test-key'
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      models: [
        {
          name: 'models/gemini-4-hydrogen',
          displayName: 'Gemini 4 Hydrogen',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/gemini-3.1-flash-image',
          displayName: 'Gemini Flash Image',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/text-embedding-005',
          displayName: 'Embedding model',
          supportedGenerationMethods: ['embedContent'],
        },
      ],
    }), { status: 200 })

  try {
    const models = await listProviderModels('gemini')
    assert.deepEqual(models, [
      {
        id: 'gemini-4-hydrogen',
        name: 'Gemini 4 Hydrogen',
        supportsVision: true,
        supportsWebSearch: true,
      },
      {
        id: 'gemini-3.1-flash-image',
        name: 'Gemini Flash Image',
        supportsImageGeneration: true,
        supportsVision: true,
        supportsWebSearch: true,
      },
    ])
    assert.equal(
      requireProviderApiKey('gemini', { GEMINI_API_KEY: ' test-key ' }),
      'test-key',
    )
  } finally {
    globalThis.fetch = originalFetch
    if (previousApiKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = previousApiKey
  }
})

test('normalizes and sorts provider model options without duplicates', () => {
  assert.deepEqual(
    normalizeProviderModels([
      { id: 'model-b', name: 'Beta' },
      { id: 'model-a', name: 'Alpha', isFree: true },
      { id: 'model-a', name: 'Duplicate' },
      { id: '  ', name: 'Invalid' },
    ]),
    [
      { id: 'model-a', name: 'Alpha', isFree: true },
      { id: 'model-b', name: 'Beta' },
    ],
  )
})

test('marks OpenRouter models free only when prompt, completion, and request costs are zero', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      data: [
        {
          id: 'google/gemini-decision-1',
          name: 'Google: Gemini Decision 1',
          architecture: {
            output_modalities: ['decisions'],
          },
        },
        {
          id: 'provider/free-model',
          name: 'Free model',
          pricing: { prompt: '0', completion: '0' },
        },
        {
          id: 'provider/paid-model',
          name: 'Paid model',
          pricing: { prompt: '0.000001', completion: '0' },
        },
        {
          id: 'provider/request-cost-model',
          name: 'Request cost model',
          pricing: { prompt: '0', completion: '0', request: '0.01' },
        },
      ],
    }), { status: 200 })

  try {
    const models = await listProviderModels('openrouter')
    assert.equal(
      models.find((model) => model.id === 'google/gemini-decision-1')?.supportsDecisionRouting,
      true,
    )
    assert.equal(models.find((model) => model.id === 'provider/free-model')?.isFree, true)
    assert.equal(models.find((model) => model.id === 'provider/paid-model')?.isFree, undefined)
    assert.equal(
      models.find((model) => model.id === 'provider/request-cost-model')?.isFree,
      undefined,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
