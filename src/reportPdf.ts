import { jsPDF } from 'jspdf'
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

  for (const rawLine of report.content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      y += 7
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
