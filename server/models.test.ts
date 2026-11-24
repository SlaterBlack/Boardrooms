import assert from 'node:assert/strict'
import test from 'node:test'
import {
  listProviderModels,
  normalizeProviderModels,
  ProviderModelsError,
  requireProviderApiKey,
} from './models.ts'

test('requires a valid provider key to list OpenAI and Anthropic models', () => {
  for (const provider of ['openai', 'anthropic'] as const) {
    assert.throws(
      () => requireProviderApiKey(provider, {}),
      (error: unknown) =>
        error instanceof ProviderModelsError &&
        error.message === 'API key invalid' &&
        error.statusCode === 401,
    )
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
