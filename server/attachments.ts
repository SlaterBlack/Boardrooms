import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { OfficeParser, type SupportedFileType } from 'officeparser'
import {
  MAX_BOARDROOM_CHAT_ATTACHMENT_BYTES,
  MAX_BOARDROOM_CHAT_ATTACHMENT_TEXT_LENGTH,
  type BoardroomChatAttachment,
} from '../shared/boardroom.ts'

const attachmentDirectory = path.join(
  process.env.BOARDROOMS_DATA_DIR?.trim() ||
    path.resolve(process.cwd(), '.boardrooms-data'),
  'attachments',
)

const officeFileTypes = {
  docx: 'docx',
  pdf: 'pdf',
  pptx: 'pptx',
  xlsx: 'xlsx',
} as const satisfies Record<string, SupportedFileType>

const supportedExtensions = new Set([
  ...Object.keys(officeFileTypes),
  'csv',
  'md',
  'markdown',
  'txt',
])

function isOfficeFileType(
  extension: string,
): extension is keyof typeof officeFileTypes {
  return Object.hasOwn(officeFileTypes, extension)
}

export class AttachmentError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function contentTypeFor(extension: string): string {
  switch (extension) {
    case 'pdf':
      return 'application/pdf'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case 'csv':
      return 'text/csv'
    case 'md':
    case 'markdown':
      return 'text/markdown'
    default:
      return 'text/plain'
  }
}

export function sanitizeChatAttachmentName(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f ||
        codePoint === 0x7f ||
        character === '/' ||
        character === '\\'
        ? '_'
        : character
    })
    .join('')
    .trim()
    .slice(0, 160)
}

function readPlainText(bytes: Buffer): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new AttachmentError('This text file is not valid UTF-8.')
  }
  if (text.includes('\0')) {
    throw new AttachmentError('This file does not contain readable text.')
  }
  return text.replace(/^\uFEFF/, '').trim()
}

async function extractText(bytes: Buffer, extension: string): Promise<string> {
  if (
    extension === 'txt' ||
    extension === 'md' ||
    extension === 'markdown' ||
    extension === 'csv'
  ) {
    return readPlainText(bytes)
  }

  if (!isOfficeFileType(extension)) {
    throw new AttachmentError('Choose a supported file to attach.')
  }

  try {
    const ast = await OfficeParser.parseOffice(bytes, {
      fileType: officeFileTypes[extension],
      extractAttachments: false,
      includeRawContent: false,
      ocr: false,
      abortSignal: AbortSignal.timeout(20_000),
      decompressionLimits: {
        maxUncompressedBytes: 32 * 1024 * 1024,
        maxZipEntries: 2_000,
        maxTableCells: 50_000,
      },
    })
    return ast.toText().trim()
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError(
      'Could not extract text from this file. Check that it is a valid, unencrypted document.',
      { cause: error },
    )
  }
}

export async function persistChatAttachment(
  originalName: unknown,
  value: unknown,
): Promise<BoardroomChatAttachment> {
  if (typeof originalName !== 'string') {
    throw new AttachmentError('Choose a supported file to attach.')
  }
  const name = sanitizeChatAttachmentName(originalName)
  const extension = name.split('.').at(-1)?.toLowerCase() ?? ''
  if (!name || name.length > 160 || !supportedExtensions.has(extension)) {
    throw new AttachmentError(
      'Choose a PDF, DOCX, TXT, Markdown, CSV, XLSX, or PPTX file.',
    )
  }
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new AttachmentError('The selected file is empty or could not be read.')
  }
  if (value.length > MAX_BOARDROOM_CHAT_ATTACHMENT_BYTES) {
    throw new AttachmentError('Files must be no larger than 10 MB.')
  }

  const extractedText = (await extractText(value, extension)).slice(
    0,
    MAX_BOARDROOM_CHAT_ATTACHMENT_TEXT_LENGTH,
  )
  if (!extractedText) {
    throw new AttachmentError(
      'No selectable text was found in this file. Scanned PDFs and image-only documents are not supported yet.',
    )
  }

  const id = randomUUID()
  await mkdir(attachmentDirectory, { recursive: true, mode: 0o700 })
  await writeFile(path.join(attachmentDirectory, `${id}.upload`), value, {
    flag: 'wx',
    mode: 0o600,
  })

  return {
    id,
    name,
    size: value.length,
    contentType: contentTypeFor(extension),
    url: `/api/boardrooms/files/${id}?name=${encodeURIComponent(name)}`,
    extractedText,
  }
}

export async function readChatAttachment(id: string): Promise<Buffer | null> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    return null
  }
  try {
    return await readFile(path.join(attachmentDirectory, `${id}.upload`))
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
}
