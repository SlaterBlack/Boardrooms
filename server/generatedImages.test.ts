import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

const dataDirectory = await mkdtemp(path.join(tmpdir(), 'discussit-image-test-'))
process.env.BOARDROOMS_DATA_DIR = dataDirectory
const { GeneratedImageError, persistRemoteImage, persistUploadedImage, readGeneratedImage } =
  await import('./generatedImages.ts')

test('persists validated chat uploads and rejects invalid image data', async () => {
  try {
    const imageUrl = await persistUploadedImage('data:image/png;base64,dGVzdA==')
    assert.match(
      imageUrl,
      /^\/api\/boardrooms\/images\/generated\/[0-9a-f-]{36}\.png$/,
    )
    const fileName = imageUrl.split('/').at(-1)
    assert.ok(fileName)
    const storedImage = await readGeneratedImage(fileName)
    assert.equal(storedImage?.contentType, 'image/png')
    assert.equal(storedImage?.data.toString(), 'test')
    await assert.rejects(persistUploadedImage('not an image'), GeneratedImageError)
  } finally {
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('persists remote generated images locally and blocks private or non-image URLs', async () => {
  const originalFetch = globalThis.fetch
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  globalThis.fetch = async () =>
    new Response(pngBytes, {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })

  try {
    const storedUrl = await persistRemoteImage('https://images.example.com/result.png')
    assert.match(
      storedUrl,
      /^\/api\/boardrooms\/images\/generated\/[0-9a-f-]{36}\.png$/,
    )
    const fileName = storedUrl.split('/').at(-1)
    assert.ok(fileName)
    const storedImage = await readGeneratedImage(fileName)
    assert.equal(storedImage?.contentType, 'image/png')
    assert.deepEqual(storedImage?.data, pngBytes)

    await assert.rejects(
      persistRemoteImage('https://127.0.0.1/secret.png'),
      GeneratedImageError,
    )
    await assert.rejects(
      persistRemoteImage('http://images.example.com/insecure.png'),
      GeneratedImageError,
    )
  } finally {
    globalThis.fetch = originalFetch
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
