import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isSecureImageUrl } from '../shared/chat.ts'

const MAX_GENERATED_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_UPLOADED_IMAGE_BYTES = 7 * 1024 * 1024
const REMOTE_IMAGE_TIMEOUT_MS = 30_000
const imageDirectory = path.join(
  process.env.BOARDROOMS_DATA_DIR?.trim() ||
    path.resolve(process.cwd(), '.boardrooms-data'),
  'images',
)

const imageTypes = {
  png: { mime: 'image/png', extension: 'png' },
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  webp: { mime: 'image/webp', extension: 'webp' },
} as const

export class GeneratedImageError extends Error {}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!ipv4) return false
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

function detectImageType(
  bytes: Buffer,
): (typeof imageTypes)[keyof typeof imageTypes] | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return imageTypes.png
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return imageTypes.jpeg
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return imageTypes.webp
  }
  return null
}

function parseImageDataUrl(
  imageDataUrl: string,
  maxBytes: number,
  invalidMessage: string,
  oversizedMessage: string,
): { bytes: Buffer; type: (typeof imageTypes)[keyof typeof imageTypes] } {
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageDataUrl)
  if (!match) throw new GeneratedImageError(invalidMessage)
  const bytes = Buffer.from(match[2], 'base64')
  if (
    bytes.length === 0 ||
    bytes.toString('base64') !== match[2]
  ) {
    throw new GeneratedImageError(invalidMessage)
  }
  if (bytes.length > maxBytes) throw new GeneratedImageError(oversizedMessage)

  const type = Object.entries(imageTypes).find(([mime]) => mime === match[1])?.[1]
  if (!type) throw new GeneratedImageError(invalidMessage)
  return { bytes, type }
}

async function writeImageBytes(
  bytes: Buffer,
  type: (typeof imageTypes)[keyof typeof imageTypes],
): Promise<string> {
  const fileName = `${randomUUID()}.${type.extension}`
  await mkdir(imageDirectory, { recursive: true, mode: 0o700 })
  await writeFile(path.join(imageDirectory, fileName), bytes, {
    flag: 'wx',
    mode: 0o600,
  })
  return `/api/boardrooms/images/generated/${fileName}`
}

async function persistImage(
  imageDataUrl: string,
  maxBytes: number,
  invalidMessage: string,
  oversizedMessage: string,
): Promise<string> {
  const { bytes, type } = parseImageDataUrl(
    imageDataUrl,
    maxBytes,
    invalidMessage,
    oversizedMessage,
  )
  return writeImageBytes(bytes, type)
}

export async function persistGeneratedImage(imageDataUrl: string): Promise<string> {
  return persistImage(
    imageDataUrl,
    MAX_GENERATED_IMAGE_BYTES,
    'The image provider returned an unsupported image.',
    'The generated image is invalid or too large to save.',
  )
}

export async function persistRemoteImage(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!isSecureImageUrl(url)) {
    throw new GeneratedImageError('The image URL must use HTTPS.')
  }
  const parsed = new URL(url)
  if (isPrivateHost(parsed.hostname)) {
    throw new GeneratedImageError('Cannot fetch images from private network hosts.')
  }

  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS)])
    : AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS)

  const response = await fetch(url, { signal: requestSignal })
  if (!response.ok) {
    throw new GeneratedImageError(`Could not download generated image (${response.status}).`)
  }
  const contentLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_GENERATED_IMAGE_BYTES) {
    throw new GeneratedImageError('The generated image is too large to save.')
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new GeneratedImageError('The generated image is invalid or too large to save.')
  }

  const detectedType = detectImageType(bytes)
  if (!detectedType) {
    throw new GeneratedImageError('The downloaded file is not a supported PNG, JPEG, or WebP image.')
  }
  return writeImageBytes(bytes, detectedType)
}

export async function persistImageSource(
  source: string,
  signal?: AbortSignal,
): Promise<string> {
  if (source.startsWith('data:')) {
    return persistGeneratedImage(source)
  }
  return persistRemoteImage(source, signal)
}

export async function persistUploadedImage(value: unknown): Promise<string> {
  if (typeof value !== 'string') {
    throw new GeneratedImageError('Choose a PNG, JPEG, or WebP image to attach.')
  }
  return persistImage(
    value,
    MAX_UPLOADED_IMAGE_BYTES,
    'Choose a PNG, JPEG, or WebP image to attach.',
    'Images must be valid and no larger than 7 MB.',
  )
}

export async function readGeneratedImage(
  fileName: string,
): Promise<{ contentType: string; data: Buffer } | null> {
  const match = /^([0-9a-f-]{36})\.(png|jpg|webp)$/.exec(fileName)
  if (!match) return null
  const contentType = match[2] === 'jpg' ? 'image/jpeg' : `image/${match[2]}`
  try {
    const data = await readFile(path.join(imageDirectory, fileName))
    return { contentType, data }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}
