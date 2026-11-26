import { GoogleGenAI } from '@google/genai'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { Provider, ProviderModel } from '../shared/boardroom.ts'

const MODEL_LIST_LIMIT = 1_000
const MODEL_LIST_TIMEOUT_MS = 10_000

export class ProviderModelsError extends Error {
  readonly statusCode: number

  constructor(
    message: string,
    statusCode: number,
  ) {
    super(message)
    this.statusCode = statusCode
  }
}

function providerKeyName(
  provider: Exclude<Provider, 'openrouter' | 'magnific'>,
): string {
  switch (provider) {
    case 'openai':
      return 'OPENAI_API_KEY'
    case 'anthropic':
      return 'ANTHROPIC_API_KEY'
    case 'gemini':
      return 'GEMINI_API_KEY'
  }
}

export function requireProviderApiKey(
  provider: Exclude<Provider, 'openrouter' | 'magnific'>,
  environment: Record<string, string | undefined> = process.env,
): string {
  const apiKey = environment[providerKeyName(provider)]?.trim()
  if (!apiKey) throw new ProviderModelsError('API key invalid', 401)
  return apiKey
}

export function normalizeProviderModels(models: ProviderModel[]): ProviderModel[] {
  const unique = new Map<string, ProviderModel>()
  for (const model of models) {
    const id = model.id.trim()
    if (!id || unique.has(id)) continue
    unique.set(id, {
      id,
      name: model.name.trim() || id,
      ...(model.isFree === true ? { isFree: true } : {}),
      ...(model.supportsDecisionRouting === true
        ? { supportsDecisionRouting: true }
        : {}),
      ...(model.supportsImageGeneration === true
        ? { supportsImageGeneration: true }
        : {}),
      ...(model.supportsImageProcessing === true
        ? { supportsImageProcessing: true }
        : {}),
      ...(model.supportsVision === true ? { supportsVision: true } : {}),
      ...(model.supportsWebSearch === true ? { supportsWebSearch: true } : {}),
    })
  }

  return [...unique.values()].sort(
    (first, second) =>
      first.name.localeCompare(second.name) || first.id.localeCompare(second.id),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isZeroPrice(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value === 0
  if (typeof value !== 'string' || !value.trim()) return false
  return Number(value) === 0
}

function isFreeOpenRouterPricing(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    isZeroPrice(value.prompt) &&
    isZeroPrice(value.completion) &&
    (value.request === undefined || value.request === null || isZeroPrice(value.request))
  )
}

function upstreamStatus(error: unknown): number | undefined {
  if (!isRecord(error) || typeof error.status !== 'number') return undefined
  return error.status
}

async function listOpenAIModels(): Promise<ProviderModel[]> {
  const client = new OpenAI({
    apiKey: requireProviderApiKey('openai'),
    maxRetries: 0,
    timeout: MODEL_LIST_TIMEOUT_MS,
  })
  const models: ProviderModel[] = []
  for await (const model of client.models.list()) {
    const supportsVision =
      /^(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4)([-.]|$)/i.test(model.id)
    const supportsImageGeneration =
      /^(gpt-image-|dall-e-)/i.test(model.id)
    const supportsWebSearch = /^(gpt-|o[134])/i.test(model.id)
    models.push({
      id: model.id,
      name: model.id,
      ...(supportsVision ? { supportsVision: true } : {}),
      ...(supportsImageGeneration ? { supportsImageGeneration: true } : {}),
      ...(supportsWebSearch ? { supportsWebSearch: true } : {}),
    })
    if (models.length >= MODEL_LIST_LIMIT) break
  }
  return normalizeProviderModels(models)
}

async function listAnthropicModels(): Promise<ProviderModel[]> {
  const client = new Anthropic({
    apiKey: requireProviderApiKey('anthropic'),
    maxRetries: 0,
    timeout: MODEL_LIST_TIMEOUT_MS,
  })
  const models: ProviderModel[] = []
  for await (const model of client.models.list()) {
    if (model.lifecycle !== 'active') continue
    models.push({
      id: model.id,
      name: model.display_name,
      supportsVision: true,
      supportsWebSearch: true,
    })
    if (models.length >= MODEL_LIST_LIMIT) break
  }
  return normalizeProviderModels(models)
}

async function listGeminiModels(): Promise<ProviderModel[]> {
  const client = new GoogleGenAI({
    apiKey: requireProviderApiKey('gemini'),
  })
  const models: ProviderModel[] = []
  const pager = await client.models.list({
    config: {
      pageSize: 100,
      abortSignal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    },
  })

  for await (const model of pager) {
    if (!model.name || !model.supportedActions?.includes('generateContent')) continue
    const id = model.name.replace(/^models\//, '')
    const isGeminiModel = /^gemini-/i.test(id)
    if (/-(?:tts|transcribe)(?:-|$)/i.test(id)) continue
    models.push({
      id,
      name: model.displayName?.trim() || id,
      ...(isGeminiModel ? { supportsVision: true } : {}),
      ...(isGeminiModel &&
      /^gemini-(?:(?:2|3|4)[.-]|(?:flash|pro)(?:-|$))/i.test(id)
        ? { supportsWebSearch: true }
        : {}),
      ...(isGeminiModel && /image|nano-banana/i.test(id)
        ? { supportsImageGeneration: true }
        : {}),
    })
    if (models.length >= MODEL_LIST_LIMIT) break
  }
  return normalizeProviderModels(models)
}

async function listOpenRouterModels(): Promise<ProviderModel[]> {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new ProviderModelsError('Could not load models from this provider.', 502)
  }

  const payload: unknown = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new ProviderModelsError('Could not load models from this provider.', 502)
  }

  const models = payload.data.flatMap((item): ProviderModel[] => {
    if (!isRecord(item) || typeof item.id !== 'string') return []
    const architecture = isRecord(item.architecture) ? item.architecture : null
    const inputModalities =
      architecture && Array.isArray(architecture.input_modalities)
        ? architecture.input_modalities
        : []
    const outputModalities =
      architecture && Array.isArray(architecture.output_modalities)
        ? architecture.output_modalities
        : []
    const supportsDecisionRouting =
        outputModalities.includes('decisions') ||
        item.id === 'google/gemini-decision-1'
    const supportedParameters = Array.isArray(item.supported_parameters)
      ? item.supported_parameters
      : []
    return [{
      id: item.id,
      name: typeof item.name === 'string' ? item.name : item.id,
      ...(supportsDecisionRouting ? { supportsDecisionRouting: true } : {}),
      ...(isFreeOpenRouterPricing(item.pricing) ? { isFree: true } : {}),
      ...(inputModalities.includes('image') ? { supportsVision: true } : {}),
      ...(outputModalities.includes('image') ? { supportsImageGeneration: true } : {}),
      ...(supportedParameters.includes('web_search_options')
        ? { supportsWebSearch: true }
        : {}),
    }]
  })
  models.push({
    id: 'google/gemini-decision-1',
    name: 'Google: Gemini Decision 1',
    supportsDecisionRouting: true,
  })
  return normalizeProviderModels(models).slice(0, MODEL_LIST_LIMIT)
}

export async function listProviderModels(provider: Provider): Promise<ProviderModel[]> {
  try {
    switch (provider) {
      case 'openai':
        return await listOpenAIModels()
      case 'anthropic':
        return await listAnthropicModels()
      case 'gemini':
        return await listGeminiModels()
      case 'openrouter':
        return await listOpenRouterModels()
      case 'magnific':
        return [
          { id: 'mystic:realism', name: 'Mystic Realism', supportsImageGeneration: true },
          { id: 'mystic:fluid', name: 'Mystic Fluid', supportsImageGeneration: true },
          { id: 'mystic:zen', name: 'Mystic Zen', supportsImageGeneration: true },
          { id: 'mystic:flexible', name: 'Mystic Flexible', supportsImageGeneration: true },
          { id: 'mystic:super_real', name: 'Mystic Super Real', supportsImageGeneration: true },
          {
            id: 'mystic:editorial_portraits',
            name: 'Mystic Editorial Portraits',
            supportsImageGeneration: true,
          },
          {
            id: 'precision-v2',
            name: 'Precision Upscaler v2',
            supportsImageProcessing: true,
          },
        ]
    }
  } catch (error) {
    if (error instanceof ProviderModelsError) throw error

    const status = upstreamStatus(error)
    if (provider !== 'openrouter' && (status === 401 || status === 403)) {
      throw new ProviderModelsError('API key invalid', 401)
    }

    console.error(`Model discovery failed for ${provider}.`)
    throw new ProviderModelsError(
      'Could not load models. Check the provider connection and try again.',
      502,
    )
  }
}
