/**
 * The formatting preview.
 *
 * This is a derived artifact and nothing else. It never edits the input file,
 * and it only ever changes padding: the raw text of every cell is copied
 * through byte for byte, so an escape such as `\|` survives exactly as written.
 *
 * A table is only reformatted when the result provably round-trips: the preview
 * is parsed again and every cell must come back identical to the cell it came
 * from. A table that cannot pass that check is copied through untouched and
 * reported, because a preview that quietly changes content would be worse than
 * no preview at all.
 */

import { parseTables } from './parse.mjs'

const MINIMUM_WIDTH = 3

/** Padding counts code points, not rendered glyph width. See docs/table-rules.md. */
function widthOf(text) {
  return Array.from(text).length
}

function pad(text, width) {
  const missing = width - widthOf(text)
  return missing > 0 ? text + ' '.repeat(missing) : text
}

function delimiterCell(alignment, width) {
  if (alignment === 'center') return `:${'-'.repeat(width - 2)}:`
  if (alignment === 'left') return `:${'-'.repeat(width - 1)}`
  if (alignment === 'right') return `${'-'.repeat(width - 1)}:`
  return '-'.repeat(width)
}

function renderLine(cells, indent) {
  return `${' '.repeat(indent)}| ${cells.join(' | ')} |`
}

function sameCells(left, right) {
  if (left.length !== right.length) return false
  return left.every((cell, index) => cell.raw === right[index].raw && cell.content === right[index].content)
}

/**
 * Render one table as aligned Markdown.
 *
 * Returns `{ safe: false, reason }` when the table cannot be reformatted
 * without risking its content, and `{ safe: true, lines }` otherwise.
 */
export function renderTable(table) {
  const rows = [table.header, ...table.rows]
  const uneven = rows.find((row) => row.cells.length !== table.columnCount)
  if (uneven !== undefined) {
    return { safe: false, reason: `row on line ${uneven.line} has ${uneven.cells.length} cells, not ${table.columnCount}` }
  }

  const widths = []
  for (let column = 0; column < table.columnCount; column += 1) {
    let width = MINIMUM_WIDTH
    for (const row of rows) width = Math.max(width, widthOf(row.cells[column].raw))
    widths.push(width)
  }

  const lines = [
    renderLine(table.header.cells.map((cell, column) => pad(cell.raw, widths[column])), table.indent),
    renderLine(table.alignments.map((alignment, column) => delimiterCell(alignment, widths[column])), table.indent),
    ...table.rows.map((row) => renderLine(row.cells.map((cell, column) => pad(cell.raw, widths[column])), table.indent)),
  ]

  const reparsed = parseTables(lines.join('\n'))
  if (reparsed.tables.length !== 1 || reparsed.problems.length > 0) {
    return { safe: false, reason: 'the preview did not parse back as a single table' }
  }
  const check = reparsed.tables[0]
  if (
    check.columnCount !== table.columnCount
    || check.rows.length !== table.rows.length
    || !sameCells(check.header.cells, table.header.cells)
    || check.alignments.some((alignment, column) => alignment !== table.alignments[column])
    || check.rows.some((row, position) => !sameCells(row.cells, table.rows[position].cells))
  ) {
    return { safe: false, reason: 'the preview did not round-trip to identical cells' }
  }

  return { safe: true, lines }
}

/**
 * Rebuild a whole document with every safely formattable table aligned.
 *
 * Lines outside a reformatted table are copied through unchanged, so the
 * preview of a document with no tables is the document itself.
 */
export function renderDocumentPreview(parsed) {
  const replacements = new Map()
  const skipped = []

  for (const table of parsed.tables) {
    const rendered = renderTable(table)
    if (!rendered.safe) {
      skipped.push({ table, reason: rendered.reason })
      continue
    }
    replacements.set(table.startLine, { endLine: table.endLine, lines: rendered.lines })
  }

  const out = []
  for (let index = 0; index < parsed.lines.length; index += 1) {
    const replacement = replacements.get(index + 1)
    if (replacement === undefined) {
      out.push(parsed.lines[index])
      continue
    }
    out.push(...replacement.lines)
    index = replacement.endLine - 1
  }

  return { text: out.join('\n'), formatted: replacements.size, skipped }
}
