import assert from 'node:assert/strict'
import test from 'node:test'
import {
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
      { id: 'model-a', name: 'Alpha' },
      { id: 'model-a', name: 'Duplicate' },
      { id: '  ', name: 'Invalid' },
    ]),
    [
      { id: 'model-a', name: 'Alpha' },
      { id: 'model-b', name: 'Beta' },
    ],
  )
})
