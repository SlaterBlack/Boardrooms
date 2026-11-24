import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_IMAGE_BYTES = 12 * 1024 * 1024
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

export async function persistGeneratedImage(
  imageDataUrl: string,
): Promise<string> {
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageDataUrl)
  if (!match) throw new GeneratedImageError('The image provider returned an unsupported image.')
  const bytes = Buffer.from(match[2], 'base64')
  if (
    bytes.length === 0 ||
    bytes.length > MAX_IMAGE_BYTES ||
    bytes.toString('base64') !== match[2]
  ) {
    throw new GeneratedImageError('The generated image is invalid or too large to save.')
  }

  const type = Object.entries(imageTypes).find(([mime]) => mime === match[1])?.[1]
  if (!type) throw new GeneratedImageError('The image provider returned an unsupported image.')
  const fileName = `${randomUUID()}.${type.extension}`
  await mkdir(imageDirectory, { recursive: true, mode: 0o700 })
  await writeFile(path.join(imageDirectory, fileName), bytes, {
    flag: 'wx',
    mode: 0o600,
  })
  return `/api/boardrooms/images/generated/${fileName}`
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
