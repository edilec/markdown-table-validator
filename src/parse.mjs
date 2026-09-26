/**
 * A focused GFM table reader.
 *
 * The reader answers one question precisely: where does every table, row and
 * cell start and end, in exact 1-based line and column numbers. Everything that
 * decides whether a table is acceptable lives in `index.mjs`; this file only
 * reports what the Markdown actually says.
 *
 * The splitting model, stated once so the rules that depend on it are honest:
 *
 *  1. A row is split at every `|` that is not preceded by a backslash escape.
 *     This is what GFM does, and it does it before any inline parsing, so a
 *     pipe inside a code span still splits the row.
 *  2. `\|` inside a cell is a literal pipe in the cell's content, including
 *     inside a code span, because the unescaping happens while the row is split.
 *  3. Code spans are located separately, using CommonMark backtick-run rules, so
 *     an unescaped pipe inside one can be reported as the portability problem it
 *     is instead of being silently swallowed.
 *
 * Both readings of a row are kept: `cells` is what GFM renders, `intentCells` is
 * what the author almost certainly meant when a code span contains a raw pipe.
 */

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 2_000_000,
  maxFiles: 500,
  maxLines: 50_000,
  maxLineLength: 10_000,
  maxTables: 500,
  maxRowsPerTable: 5_000,
  maxColumns: 200,
  timeLimitMs: 10_000,
})

export const ALIGNMENTS = Object.freeze(['none', 'left', 'right', 'center'])

const DELIMITER_CELL = /^:?-+:?$/
const DELIMITER_LINE = /^[-:| \t]*-[-:| \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const THEMATIC_BREAK = /^ {0,3}([-*_])( *\1){2,} *$/
const ATX_HEADING = /^#{1,6}(\s|$)/

/** A declared limit was exceeded. Never silently truncate; the caller reports it. */
export class LimitExceeded extends Error {
  constructor(limit, allowed, observed, line = null) {
    super(`${limit} limit of ${allowed} exceeded (observed ${observed})`)
    this.name = 'LimitExceeded'
    this.limit = limit
    this.allowed = allowed
    this.observed = observed
    this.line = line
  }
}

/** A wall-clock budget ran out before the input was fully read. */
export class TimeLimitExceeded extends LimitExceeded {
  constructor(allowed, line) {
    super('timeLimitMs', allowed, allowed, line)
    this.name = 'TimeLimitExceeded'
  }
}

function indentOf(line) {
  return line.length - line.trimStart().length
}

/**
 * Mark every index covered by a code span, delimiters included.
 *
 * A run of N backticks opens a span that ends at the next run of exactly N
 * backticks. A backslash escape stops a run from opening one; inside a span
 * backslashes are literal, which is why the closing search ignores them.
 */
export function codeSpanMask(text) {
  const mask = new Uint8Array(text.length)
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char !== '`') {
      index += 1
      continue
    }
    const openStart = index
    while (index < text.length && text[index] === '`') index += 1
    const runLength = index - openStart
    let cursor = index
    let closeEnd = -1
    while (cursor < text.length) {
      if (text[cursor] !== '`') {
        cursor += 1
        continue
      }
      const runStart = cursor
      while (cursor < text.length && text[cursor] === '`') cursor += 1
      if (cursor - runStart === runLength) {
        closeEnd = cursor
        break
      }
    }
    if (closeEnd === -1) continue
    mask.fill(1, openStart, closeEnd)
    index = closeEnd
  }
  return mask
}

/** Turn `\|` back into a literal pipe, leaving every other escape untouched. */
export function unescapePipes(raw) {
  if (!raw.includes('\\')) return raw
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === '\\' && index + 1 < raw.length) {
      out += raw[index + 1] === '|' ? '|' : raw[index] + raw[index + 1]
      index += 1
      continue
    }
    out += raw[index]
  }
  return out
}

function cellOf(raw, start) {
  const trimmed = raw.trim()
  // Point at the first character of the content, or at the start of an empty cell.
  const offset = trimmed === '' ? 0 : raw.length - raw.trimStart().length
  return {
    raw: trimmed,
    content: unescapePipes(trimmed),
    start,
    column: start + 1 + offset,
  }
}

/**
 * Split one row into cells.
 *
 * Returns the GFM reading (`cells`), the code-span-protected reading
 * (`intentCells`), the absolute indices of unescaped pipes that sit inside a
 * code span, and whether the row carried the optional outer pipes.
 */
export function splitRow(line) {
  const mask = codeSpanMask(line)
  const segments = []
  const boundaries = []
  const pipes = []
  const codeSpanPipes = []
  let raw = ''
  let start = 0

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\' && index + 1 < line.length) {
      raw += char + line[index + 1]
      index += 1
      continue
    }
    if (char === '|') {
      pipes.push(index)
      boundaries.push(mask[index] === 1)
      if (mask[index] === 1) codeSpanPipes.push(index)
      segments.push({ raw, start })
      raw = ''
      start = index + 1
      continue
    }
    raw += char
  }
  segments.push({ raw, start })

  const firstText = line.search(/\S/)
  const trimmedEnd = line.trimEnd()
  const lastText = trimmedEnd.length - 1
  const leadingPipe = pipes.length > 0 && pipes[0] === firstText
  const trailingPipe = pipes.length > 0 && pipes[pipes.length - 1] === lastText

  let kept = segments
  let keptBoundaries = boundaries
  if (leadingPipe && kept.length > 1) {
    kept = kept.slice(1)
    keptBoundaries = keptBoundaries.slice(1)
  }
  if (trailingPipe && kept.length > 1) {
    kept = kept.slice(0, -1)
    keptBoundaries = keptBoundaries.slice(0, -1)
  }

  const cells = kept.map((segment) => cellOf(segment.raw, segment.start))

  const intent = []
  let accumulator = null
  for (let index = 0; index < kept.length; index += 1) {
    if (accumulator === null) accumulator = { raw: kept[index].raw, start: kept[index].start }
    else accumulator.raw += `|${kept[index].raw}`
    if (index < kept.length - 1 && keptBoundaries[index]) continue
    intent.push(cellOf(accumulator.raw, accumulator.start))
    accumulator = null
  }

  return {
    cells,
    intentCells: intent,
    codeSpanPipes,
    pipeCount: pipes.length,
    leadingPipe,
    trailingPipe,
  }
}

/** Read the alignment a delimiter cell declares. */
export function alignmentOf(cellText) {
  const text = cellText.trim()
  const left = text.startsWith(':')
  const right = text.endsWith(':') && text.length > 1
  if (left && right) return 'center'
  if (left) return 'left'
  if (right) return 'right'
  return 'none'
}

/**
 * Is this line a delimiter row, or an attempt at one?
 *
 * `strict` means it is built only from the characters a delimiter row may
 * contain. `near` means it carries pipes and at least half of its cells are
 * real delimiter cells: not a table to any renderer, but unmistakably meant to
 * be one, so the exact cell that has to change can be named instead of the
 * whole block being passed over in silence.
 */
function delimiterCandidate(line) {
  if (line === undefined) return null
  const trimmed = line.trim()
  if (trimmed === '' || indentOf(line) > 3) return null
  if (DELIMITER_LINE.test(trimmed)) return 'strict'
  const split = splitRow(line)
  if (split.pipeCount === 0 || split.cells.length === 0) return null
  const matching = split.cells.filter((cell) => DELIMITER_CELL.test(cell.raw)).length
  if (matching === 0) return null
  return matching * 2 >= split.cells.length ? 'near' : null
}

function endsTable(line) {
  if (line === undefined) return true
  if (line.trim() === '') return true
  if (FENCE.test(line)) return true
  if (THEMATIC_BREAK.test(line)) return true
  const trimmed = line.trimStart()
  if (ATX_HEADING.test(trimmed)) return true
  if (trimmed.startsWith('>')) return true
  return false
}

function makeRow(line, number, kind) {
  const split = splitRow(line)
  return {
    kind,
    line: number,
    text: line,
    indent: indentOf(line),
    ...split,
  }
}

/**
 * Read every table in a document.
 *
 * `tables` holds the blocks GFM will render as tables. `problems` holds blocks
 * that were clearly meant to be tables but cannot be one, each with the exact
 * line that has to change.
 */
export function parseTables(text, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  const clock = options.clock ?? null
  const deadline = clock === null ? null : clock() + limits.timeLimitMs

  const rawLines = text.split('\n')
  if (rawLines.length > limits.maxLines) {
    throw new LimitExceeded('maxLines', limits.maxLines, rawLines.length)
  }
  const lines = rawLines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].length > limits.maxLineLength) {
      throw new LimitExceeded('maxLineLength', limits.maxLineLength, lines[index].length, index + 1)
    }
  }

  const tables = []
  const problems = []
  let fence = null

  for (let index = 0; index < lines.length; index += 1) {
    if (deadline !== null && clock() > deadline) throw new TimeLimitExceeded(limits.timeLimitMs, index + 1)

    const line = lines[index]
    const fenceMatch = FENCE.exec(line)
    if (fence !== null) {
      if (
        fenceMatch !== null
        && fenceMatch[1][0] === fence.char
        && fenceMatch[1].length >= fence.length
        && fenceMatch[2].trim() === ''
      ) fence = null
      continue
    }
    if (fenceMatch !== null && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length }
      continue
    }

    if (line.trim() === '' || indentOf(line) > 3) continue
    if (delimiterCandidate(lines[index + 1]) === null) continue

    const header = makeRow(line, index + 1, 'header')
    if (header.pipeCount === 0) continue

    const delimiter = makeRow(lines[index + 1], index + 2, 'delimiter')
    const invalid = delimiter.cells.filter((cell) => !DELIMITER_CELL.test(cell.raw))
    if (delimiter.cells.length === 0 || invalid.length > 0) {
      if (delimiter.pipeCount > 0) {
        problems.push({
          kind: 'delimiter-row-invalid',
          line: delimiter.line,
          column: invalid.length > 0 ? invalid[0].column : 1,
          text: delimiter.text,
          detail: invalid.length > 0 ? invalid[0].raw : delimiter.text.trim(),
        })
      }
      continue
    }

    const columnCount = delimiter.cells.length
    if (header.cells.length !== columnCount && header.intentCells.length !== columnCount) {
      if (delimiter.pipeCount > 0) {
        problems.push({
          kind: 'header-delimiter-count-mismatch',
          line: delimiter.line,
          column: 1,
          text: delimiter.text,
          headerLine: header.line,
          headerCount: header.cells.length,
          delimiterCount: columnCount,
        })
      }
      continue
    }

    if (columnCount > limits.maxColumns) {
      throw new LimitExceeded('maxColumns', limits.maxColumns, columnCount, delimiter.line)
    }

    const rows = []
    let cursor = index + 2
    while (!endsTable(lines[cursor])) {
      if (rows.length >= limits.maxRowsPerTable) {
        throw new LimitExceeded('maxRowsPerTable', limits.maxRowsPerTable, rows.length + 1, cursor + 1)
      }
      if (deadline !== null && clock() > deadline) throw new TimeLimitExceeded(limits.timeLimitMs, cursor + 1)
      rows.push(makeRow(lines[cursor], cursor + 1, 'body'))
      cursor += 1
    }

    if (tables.length >= limits.maxTables) {
      throw new LimitExceeded('maxTables', limits.maxTables, tables.length + 1, header.line)
    }

    tables.push({
      index: tables.length,
      indent: header.indent,
      columnCount,
      alignments: delimiter.cells.map((cell) => alignmentOf(cell.raw)),
      header,
      delimiter,
      rows,
      startLine: header.line,
      endLine: rows.length > 0 ? rows[rows.length - 1].line : delimiter.line,
    })

    index = cursor - 1
  }

  return { lines, tables, problems }
}
