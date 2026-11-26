import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { jsPDF } from 'jspdf'

const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'discussit-attachments-'))
process.env.BOARDROOMS_DATA_DIR = dataDirectory
const {
  AttachmentError,
  persistChatAttachment,
  readChatAttachment,
} = await import('./attachments.ts')

test.after(async () => {
  await rm(dataDirectory, { recursive: true, force: true })
})

test('persists original text attachments and returns bounded extracted text', async () => {
  const contents = Buffer.from('# Planning\\n\\nKeep the review focused.', 'utf8')
  const attachment = await persistChatAttachment('../planning.md', contents)

  assert.equal(attachment.name, '.._planning.md')
  assert.equal(attachment.extractedText, '# Planning\\n\\nKeep the review focused.')
  assert.deepEqual(await readChatAttachment(attachment.id), contents)
  assert.match(attachment.url, new RegExp(`/api/boardrooms/files/${attachment.id}\\?name=`))
})

test('extracts selectable text from PDF files', async () => {
  const document = new jsPDF()
  document.text('Quarterly plan: keep the review focused.', 20, 20)
  const bytes = Buffer.from(document.output('arraybuffer'))
  const attachment = await persistChatAttachment('quarterly-plan.pdf', bytes)

  assert.ok(attachment.extractedText.includes('Quarterly plan: keep the review focused.'))
  assert.deepEqual(await readChatAttachment(attachment.id), bytes)
})

test('rejects unsupported, invalid, empty, and oversized file uploads', async () => {
  await assert.rejects(
    persistChatAttachment('script.js', Buffer.from('not a document')),
    AttachmentError,
  )
  await assert.rejects(
    persistChatAttachment('notes.txt', Buffer.from([0xff, 0xfe])),
    /valid UTF-8/,
  )
  await assert.rejects(persistChatAttachment('empty.txt', Buffer.alloc(0)), /empty/)
  await assert.rejects(
    persistChatAttachment('large.txt', Buffer.alloc(10 * 1024 * 1024 + 1)),
    /10 MB/,
  )
})

test('rejects invalid office document data without storing it', async () => {
  await assert.rejects(
    persistChatAttachment('broken.docx', Buffer.from('not a DOCX archive')),
    /valid, unencrypted document/,
  )
})
