import { jsPDF } from 'jspdf'
import autoTable, { type HAlignType } from 'jspdf-autotable'
import type { BoardroomReport } from '../shared/boardroom'

function pdfSafeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/•/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\*\*/g, '')
    .replace(/__+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim()
  const content = trimmed
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
  const cells: string[] = []
  let cell = ''
  let inCode = false

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (character === '\\' && content[index + 1] === '|') {
      cell += '|'
      index += 1
    } else if (character === '`') {
      inCode = !inCode
      cell += character
    } else if (character === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += character
    }
  }
  cells.push(cell.trim())
  return cells
}

function isMarkdownTableSeparator(cells: string[]): boolean {
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function tableAlignment(separator: string): HAlignType {
  const left = separator.startsWith(':')
  const right = separator.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  return 'left'
}

export function createReportPdf(report: BoardroomReport): jsPDF {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 48
  const lineHeight = 16
  let y = margin

  pdf.setProperties({
    title: report.title,
    subject: `${report.type} report`,
    creator: 'Boardrooms',
  })

  function ensureSpace(height: number) {
    if (y + height <= pageHeight - margin) return
    pdf.addPage()
    y = margin
  }

  function writeText(
    text: string,
    size: number,
    bold: boolean,
    indent = 0,
  ) {
    pdf.setFont('helvetica', bold ? 'bold' : 'normal')
    pdf.setFontSize(size)
    const lines = pdf.splitTextToSize(pdfSafeText(text), pageWidth - margin * 2 - indent)
    const rowHeight = Math.max(lineHeight, size + 3)
    for (const line of lines) {
      ensureSpace(rowHeight + 2)
      pdf.text(line, margin + indent, y)
      y += rowHeight
    }
  }

  pdf.setTextColor(43, 58, 49)
  writeText(report.title, 21, true)
  pdf.setTextColor(112, 126, 115)
  writeText(
    `${report.type.charAt(0).toUpperCase()}${report.type.slice(1)} report · ${new Date(report.createdAt).toLocaleDateString()}`,
    9,
    false,
  )
  y += 7
  pdf.setDrawColor(220, 229, 220)
  pdf.line(margin, y, pageWidth - margin, y)
  y += 20
  pdf.setTextColor(55, 68, 58)

  const lines = report.content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) {
      y += 7
      continue
    }

    const headers = splitMarkdownTableRow(line)
    const separator = lines[index + 1]
      ? splitMarkdownTableRow(lines[index + 1])
      : []
    if (headers.length > 1 && isMarkdownTableSeparator(separator)) {
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index].trim()) {
        const row = splitMarkdownTableRow(lines[index])
        if (row.length < 2) break
        rows.push(row)
        index += 1
      }
      index -= 1

      const columnCount = Math.max(
        headers.length,
        ...rows.map((row) => row.length),
      )
      const normalizedHeaders = Array.from(
        { length: columnCount },
        (_, column) => pdfSafeText(headers[column] ?? ''),
      )
      const normalizedRows = rows.map((row) =>
        Array.from(
          { length: columnCount },
          (_, column) => pdfSafeText(row[column] ?? ''),
        ),
      )
      const columnStyles = Object.fromEntries(
        Array.from({ length: columnCount }, (_, column) => [
          column,
          { halign: tableAlignment(separator[column] ?? '---') },
        ]),
      )

      autoTable(pdf, {
        head: [normalizedHeaders],
        body: normalizedRows,
        startY: y,
        margin: { top: margin, right: margin, bottom: margin, left: margin },
        theme: 'grid',
        styles: {
          font: 'helvetica',
          fontSize: 8,
          cellPadding: 5,
          overflow: 'linebreak',
          valign: 'top',
          lineColor: [220, 229, 220],
          textColor: [55, 68, 58],
        },
        headStyles: {
          fillColor: [74, 102, 79],
          textColor: [255, 255, 255],
          fontStyle: 'bold',
        },
        alternateRowStyles: { fillColor: [247, 250, 246] },
        columnStyles,
      })

      const table = (
        pdf as jsPDF & { lastAutoTable?: { finalY: number } }
      ).lastAutoTable
      if (!table || typeof table.finalY !== 'number') {
        throw new Error('Could not determine the report table layout.')
      }
      y = table.finalY + 12
      continue
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      y += 5
      writeText(heading[2], heading[1].length === 1 ? 16 : 12, true)
      y += 2
      continue
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (bullet) {
      writeText(`- ${bullet[1]}`, 10, false, 12)
      continue
    }

    writeText(line, 10, false)
  }

  const pageCount = pdf.getNumberOfPages()
  for (let page = 1; page <= pageCount; page += 1) {
    pdf.setPage(page)
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(8)
    pdf.setTextColor(145, 153, 146)
    pdf.text(`Page ${page} of ${pageCount}`, pageWidth - margin, pageHeight - 22, {
      align: 'right',
    })
  }

  return pdf
}

export function downloadReportPdf(report: BoardroomReport): void {
  const filename =
    report.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'boardroom-report'
  createReportPdf(report).save(`${filename}.pdf`)
}
