import assert from 'node:assert/strict'
import test from 'node:test'
import { createReportPdf } from '../src/reportPdf.ts'

test('creates a valid multi-page PDF from a boardroom report', () => {
  const pdf = createReportPdf({
    id: 'report-1',
    title: 'Architecture review',
    type: 'review',
    content: Array.from(
      { length: 120 },
      (_, index) => `## Finding ${index + 1}\n\nA practical review finding.`,
    ).join('\n\n'),
    createdAt: '2026-01-01T00:00:00.000Z',
  })

  assert.ok(pdf.output().startsWith('%PDF-'))
  assert.ok(pdf.getNumberOfPages() > 1)
})

test('renders Markdown table rows as PDF table cells', () => {
  const pdf = createReportPdf({
    id: 'report-table',
    title: 'Scope table',
    type: 'scope',
    content: [
      '| Stage | Lead | Deliverable |',
      '|:---|:---:|---:|',
      '| Discovery | Architect | Brief |',
      '| Design | Client | Options \\| estimate |',
    ].join('\n'),
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  const table = (
    pdf as typeof pdf & {
      lastAutoTable?: {
        head: unknown[]
        body: unknown[]
        columns: unknown[]
      }
    }
  ).lastAutoTable

  assert.ok(table)
  assert.equal(table.columns.length, 3)
  assert.equal(table.body.length, 2)
})
