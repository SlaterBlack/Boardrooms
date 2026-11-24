import { isSecureImageUrl } from '../shared/chat.ts'

const MAGNIFIC_API_URL = 'https://api.magnific.com/v1/ai/image-upscaler-precision-v2'
const MAGNIFIC_MYSTIC_API_URL = 'https://api.magnific.com/v1/ai/mystic'
const MAX_IMAGE_BYTES = 7 * 1024 * 1024
const TASK_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 1_500

export type MagnificFlavor = 'photo' | 'sublime' | 'photo_denoiser'

export interface MagnificUpscaleInput {
  image: string
  scaleFactor: 2 | 4 | 8 | 16
  flavor: MagnificFlavor
}

export interface MagnificGenerationInput {
  prompt: string
  model: string
}

export class MagnificInputError extends Error {}

export class MagnificError extends Error {
  readonly statusCode: number

  constructor(
    message: string,
    statusCode = 502,
  ) {
    super(message)
    this.statusCode = statusCode
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseMagnificUpscaleInput(value: unknown): MagnificUpscaleInput {
  if (!isRecord(value)) {
    throw new MagnificInputError('Request body must be an object.')
  }

  const image = value.image
  const match =
    typeof image === 'string'
      ? /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image)
      : null
  if (!match) {
    throw new MagnificInputError('Choose a PNG, JPEG, or WebP image to upscale.')
  }

  const bytes = Buffer.from(match[2], 'base64')
  if (
    bytes.length === 0 ||
    bytes.length > MAX_IMAGE_BYTES ||
    bytes.toString('base64') !== match[2]
  ) {
    throw new MagnificInputError('Images must be valid and no larger than 7 MB.')
  }

  const scaleFactor = value.scaleFactor === undefined ? 2 : value.scaleFactor
  if (scaleFactor !== 2 && scaleFactor !== 4 && scaleFactor !== 8 && scaleFactor !== 16) {
    throw new MagnificInputError('Choose an image scale of 2x, 4x, 8x, or 16x.')
  }

  const flavor = value.flavor === undefined ? 'photo' : value.flavor
  if (
    flavor !== 'photo' &&
    flavor !== 'sublime' &&
    flavor !== 'photo_denoiser'
  ) {
    throw new MagnificInputError('Choose a supported image processing style.')
  }

  return { image: match[2], scaleFactor, flavor }
}

function readTask(value: unknown): {
  status: string
  taskId: string
  generated: string[]
} {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new MagnificError('Magnific returned an invalid task response.')
  }

  const task = value.data
  if (typeof task.status !== 'string' || typeof task.task_id !== 'string') {
    throw new MagnificError('Magnific returned an invalid task response.')
  }
  const generated =
    task.generated === undefined
      ? []
      : Array.isArray(task.generated) &&
          task.generated.every((url) => typeof url === 'string')
        ? task.generated
        : null
  if (generated === null) {
    throw new MagnificError('Magnific returned an invalid image result.')
  }

  return {
    status: task.status.toUpperCase(),
    taskId: task.task_id,
    generated,
  }
}

async function readMagnificResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new MagnificError('Magnific rejected its API key. Check MAGNIFIC_API_KEY.')
    }
    if (response.status === 429) {
      throw new MagnificError('Magnific rate limit reached. Try again later.', 429)
    }
    if (response.status === 503) {
      throw new MagnificError('Magnific is temporarily unavailable. Try again later.', 503)
    }
    throw new MagnificError(`Magnific request failed (${response.status}).`)
  }

  try {
    return await response.json() as unknown
  } catch {
    throw new MagnificError('Magnific returned an invalid response.')
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function upscaleWithMagnific(
  input: MagnificUpscaleInput,
  signal: AbortSignal,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const apiKey = process.env.MAGNIFIC_API_KEY?.trim()
  if (!apiKey) {
    throw new MagnificError('Configure MAGNIFIC_API_KEY on the DiscussIt server.', 503)
  }

  const timeoutMs = options.timeoutMs ?? TASK_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])

  try {
    const createdResponse = await fetch(MAGNIFIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-magnific-api-key': apiKey,
      },
      body: JSON.stringify({
        image: input.image,
        scale_factor: input.scaleFactor,
        flavor: input.flavor,
      }),
      signal: requestSignal,
    })
    let task = readTask(await readMagnificResponse(createdResponse))

    while (task.status !== 'COMPLETED' && task.status !== 'FAILED') {
      await wait(pollIntervalMs, requestSignal)
      const taskResponse = await fetch(
        `${MAGNIFIC_API_URL}/${encodeURIComponent(task.taskId)}`,
        {
          headers: { 'x-magnific-api-key': apiKey },
          signal: requestSignal,
        },
      )
      task = readTask(await readMagnificResponse(taskResponse))
    }

    if (task.status === 'FAILED') {
      throw new MagnificError('Magnific could not upscale this image.')
    }
    const imageUrl = task.generated[0]
    if (!isSecureImageUrl(imageUrl)) {
      throw new MagnificError('Magnific did not return a secure image URL.')
    }
    return imageUrl
  } catch (error) {
    if (signal.aborted) throw error
    if (requestSignal.aborted) {
      throw new MagnificError('Magnific image processing timed out.', 504)
    }
    throw error
  }
}

export async function generateWithMagnific(
  input: MagnificGenerationInput,
  signal: AbortSignal,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const apiKey = process.env.MAGNIFIC_API_KEY?.trim()
  if (!apiKey) {
    throw new MagnificError('Configure MAGNIFIC_API_KEY on the DiscussIt server.', 503)
  }
  const model = input.model.replace(/^mystic:/, '')
  if (
    ![
      'realism',
      'fluid',
      'zen',
      'flexible',
      'super_real',
      'editorial_portraits',
    ].includes(model)
  ) {
    throw new MagnificError('Choose a supported Magnific Mystic model.', 400)
  }

  const timeoutMs = options.timeoutMs ?? TASK_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  try {
    const createdResponse = await fetch(MAGNIFIC_MYSTIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-magnific-api-key': apiKey,
      },
      body: JSON.stringify({
        prompt: input.prompt,
        model,
        resolution: '1k',
        aspect_ratio: 'square_1_1',
      }),
      signal: requestSignal,
    })
    let task = readTask(await readMagnificResponse(createdResponse))
    while (task.status !== 'COMPLETED' && task.status !== 'FAILED') {
      await wait(pollIntervalMs, requestSignal)
      const taskResponse = await fetch(
        `${MAGNIFIC_MYSTIC_API_URL}/${encodeURIComponent(task.taskId)}`,
        {
          headers: { 'x-magnific-api-key': apiKey },
          signal: requestSignal,
        },
      )
      task = readTask(await readMagnificResponse(taskResponse))
    }

    if (task.status === 'FAILED') {
      throw new MagnificError('Magnific could not generate this image.')
    }
    const imageUrl = task.generated[0]
    if (!isSecureImageUrl(imageUrl)) {
      throw new MagnificError('Magnific did not return a secure image URL.')
    }
    return imageUrl
  } catch (error) {
    if (signal.aborted) throw error
    if (requestSignal.aborted) {
      throw new MagnificError('Magnific image generation timed out.', 504)
    }
    throw error
  }
}
