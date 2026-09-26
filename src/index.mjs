/**
 * markdown-table-validator: check Markdown tables for shape, escaping,
 * header structure, alignment and configured content constraints.
 *
 * Two promises hold this tool together.
 *
 * Exactness: every finding names the 1-based line and column of the character
 * that has to change. A report that says "a table is broken somewhere" is not
 * worth reading.
 *
 * Honesty: input that could not be read, decoded or fully parsed is reported as
 * `incomplete` and exits 2. It is never a pass, and a limit is never a silent
 * truncation.
 */

import { readFile, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import { DEFAULT_LIMITS, LimitExceeded, parseTables } from './parse.mjs'
import { renderDocumentPreview } from './format.mjs'

export { DEFAULT_LIMITS, LimitExceeded, parseTables, splitRow, codeSpanMask, alignmentOf, unescapePipes } from './parse.mjs'
export { renderDocumentPreview, renderTable } from './format.mjs'

export const TOOL_ID = 'markdown-table-validator'
export const REPORT_SCHEMA_VERSION = '1'
export const CONFIG_SCHEMA_VERSION = '1'

/** Rule catalog. The ids are stable; renaming one is a breaking change. */
export const RULES = Object.freeze({
  'delimiter-row-invalid': 'error',
  'header-delimiter-count-mismatch': 'error',
  'column-count-mismatch': 'error',
  'pipe-in-code-span': 'error',
  'header-cell-empty': 'warning',
  'header-cell-duplicate': 'warning',
  'pipe-style-inconsistent': 'warning',
  'table-has-no-data-rows': 'warning',
  'column-missing': 'error',
  'cell-required-empty': 'error',
  'cell-value-not-allowed': 'error',
  'cell-pattern-mismatch': 'error',
  'cell-value-duplicate': 'warning',
  'cell-too-long': 'warning',
  'column-alignment-unexpected': 'warning',
  'preview-unavailable': 'info',
  'input-unreadable': 'error',
  'input-not-text': 'error',
  'input-not-utf8': 'error',
  'limit-exceeded': 'error',
})

const EVIDENCE_CODE_POINTS = 120
const MAX_PATTERN_LENGTH = 200
const COLUMN_KEYS = Object.freeze(['required', 'pattern', 'maxLength', 'allowedValues', 'alignment', 'unique'])
const CONFIG_KEYS = Object.freeze(['schemaVersion', 'limits', 'columns', 'requiredColumns'])
const ALIGNMENT_VALUES = Object.freeze(['none', 'left', 'right', 'center'])

function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function codePoints(text) {
  return Array.from(text)
}

/**
 * Evidence is bounded and escaped.
 *
 * Control characters and the line separators become escape text, so a report
 * stays one readable line per finding and an excerpt of someone else's document
 * can never be mistaken for a directive.
 */
function evidenceOf(text) {
  const characters = codePoints(text.trim())
  const bounded = characters.length > EVIDENCE_CODE_POINTS
    ? `${characters.slice(0, EVIDENCE_CODE_POINTS).join('')} [...]`
    : characters.join('')
  let out = ''
  for (const character of bounded) {
    const code = character.codePointAt(0)
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    out += character
  }
  return out
}

/**
 * Say what a JSON parse failure was, without reproducing the document.
 *
 * V8 reports a parse failure two ways, and one of them quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. The quoted
 * run is the first ten characters of the document, or the whole document when
 * it is shorter than that -- so a file short enough to be nothing but a
 * credential is reproduced in full by its own error message, and interpolating
 * that message into a diagnostic walks the secret straight onto the stream.
 * Truncating does not help either: the snippet is at the front of the message.
 *
 * Position, line and column are the useful half and say nothing about content,
 * so they are kept whole. The quoted half never leaves this function. The
 * closing guard is deliberate belt and braces: every parse message V8 emits
 * without a snippet quotes JSON punctuation with apostrophes and holds no
 * double quote at all, so a double quote surviving to the end means a wording
 * this function has not been taught, and the generic sentence is used instead.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const POSITION = /at position \d+(?: \(line \d+ column \d+\))?/

/**
 * The shape that quotes the input. A leading `...` means the quoted run came
 * from the middle of the document rather than its start, which is the only
 * thing about the position this shape reveals.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

function finding(ruleId, message, where, extra = {}) {
  return {
    ruleId,
    severity: RULES[ruleId],
    message,
    location: { file: where.file, pointer: where.pointer },
    line: where.line,
    column: where.column,
    ...extra,
  }
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

/** Validate a configuration object. Anything unexpected is a usage error, never a default. */
export function parseConfig(value) {
  if (!isRecord(value)) throw new Error('Configuration must be a JSON object')
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.includes(key)) throw new Error(`Unknown configuration key "${key}"`)
  }
  if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`Configuration schemaVersion must be "${CONFIG_SCHEMA_VERSION}"`)
  }

  const limits = { ...DEFAULT_LIMITS }
  if (value.limits !== undefined) {
    if (!isRecord(value.limits)) throw new Error('Configuration "limits" must be an object')
    for (const [key, limit] of Object.entries(value.limits)) {
      if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new Error(`Unknown limit "${key}"`)
      if (!positiveInteger(limit)) throw new Error(`Limit "${key}" must be a positive integer`)
      limits[key] = limit
    }
  }

  const columns = {}
  if (value.columns !== undefined) {
    if (!isRecord(value.columns)) throw new Error('Configuration "columns" must be an object')
    for (const [name, rule] of Object.entries(value.columns)) {
      if (!isRecord(rule)) throw new Error(`Column "${name}" must map to an object`)
      for (const key of Object.keys(rule)) {
        if (!COLUMN_KEYS.includes(key)) throw new Error(`Unknown constraint "${key}" on column "${name}"`)
      }
      const normalized = {}
      if (rule.required !== undefined) {
        if (typeof rule.required !== 'boolean') throw new Error(`Column "${name}": "required" must be a boolean`)
        normalized.required = rule.required
      }
      if (rule.unique !== undefined) {
        if (typeof rule.unique !== 'boolean') throw new Error(`Column "${name}": "unique" must be a boolean`)
        normalized.unique = rule.unique
      }
      if (rule.maxLength !== undefined) {
        if (!positiveInteger(rule.maxLength)) throw new Error(`Column "${name}": "maxLength" must be a positive integer`)
        normalized.maxLength = rule.maxLength
      }
      if (rule.allowedValues !== undefined) {
        if (!Array.isArray(rule.allowedValues) || rule.allowedValues.length === 0
          || rule.allowedValues.some((entry) => typeof entry !== 'string')) {
          throw new Error(`Column "${name}": "allowedValues" must be a non-empty array of strings`)
        }
        normalized.allowedValues = [...rule.allowedValues]
      }
      if (rule.alignment !== undefined) {
        if (!ALIGNMENT_VALUES.includes(rule.alignment)) {
          throw new Error(`Column "${name}": "alignment" must be one of ${ALIGNMENT_VALUES.join(', ')}`)
        }
        normalized.alignment = rule.alignment
      }
      if (rule.pattern !== undefined) {
        if (typeof rule.pattern !== 'string' || rule.pattern === '') {
          throw new Error(`Column "${name}": "pattern" must be a non-empty string`)
        }
        if (rule.pattern.length > MAX_PATTERN_LENGTH) {
          throw new Error(`Column "${name}": "pattern" must be at most ${MAX_PATTERN_LENGTH} characters`)
        }
        try {
          normalized.regexp = new RegExp(rule.pattern, 'u')
        } catch (error) {
          throw new Error(`Column "${name}": "pattern" is not a valid regular expression: ${error.message}`)
        }
        normalized.pattern = rule.pattern
      }
      columns[name] = normalized
    }
  }

  const requiredColumns = []
  if (value.requiredColumns !== undefined) {
    if (!Array.isArray(value.requiredColumns) || value.requiredColumns.some((entry) => typeof entry !== 'string')) {
      throw new Error('Configuration "requiredColumns" must be an array of strings')
    }
    requiredColumns.push(...value.requiredColumns)
  }

  return { schemaVersion: CONFIG_SCHEMA_VERSION, limits, columns, requiredColumns }
}

export const EMPTY_CONFIG = Object.freeze(parseConfig({ schemaVersion: CONFIG_SCHEMA_VERSION }))

/** The cells a row was meant to have, falling back to what GFM will actually render. */
function effectiveCells(row, columnCount) {
  if (row.cells.length === columnCount) return row.cells
  if (row.intentCells.length === columnCount) return row.intentCells
  return row.cells
}

function checkRowShape(row, table, position, file, findings) {
  const pointer = row.kind === 'body'
    ? `/tables/${table.index}/rows/${position}`
    : `/tables/${table.index}/${row.kind}`

  for (const pipe of row.codeSpanPipes) {
    findings.push(finding(
      'pipe-in-code-span',
      'An unescaped pipe inside a code span still splits this row in GFM, so the text after it becomes a new column.',
      { file, pointer, line: row.line, column: pipe + 1 },
      {
        evidence: evidenceOf(row.text),
        suggestion: 'Escape it as \\| inside the code span; GFM unescapes it before the span is rendered.',
      },
    ))
  }

  if (row.cells.length === table.columnCount) return
  if (row.codeSpanPipes.length > 0 && row.intentCells.length === table.columnCount) return

  const rendered = row.cells.length < table.columnCount
    ? `GFM renders ${table.columnCount - row.cells.length} trailing empty cell(s)`
    : `GFM drops the ${row.cells.length - table.columnCount} extra cell(s)`
  findings.push(finding(
    'column-count-mismatch',
    `This row has ${row.cells.length} cell(s) but the table declares ${table.columnCount}. ${rendered}.`,
    { file, pointer, line: row.line, column: 1 },
    { evidence: evidenceOf(row.text), suggestion: `Write exactly ${table.columnCount} cell(s) on this line.` },
  ))
}

function checkHeader(table, file, findings) {
  const cells = effectiveCells(table.header, table.columnCount)
  const seen = new Map()
  for (let column = 0; column < cells.length; column += 1) {
    const cell = cells[column]
    const pointer = `/tables/${table.index}/header/cells/${column}`
    if (cell.content === '') {
      findings.push(finding(
        'header-cell-empty',
        `Column ${column + 1} has an empty header, so nothing names it in the rendered table.`,
        { file, pointer, line: table.header.line, column: cell.column },
        { suggestion: 'Give the column a heading, or drop the column.' },
      ))
      continue
    }
    const first = seen.get(cell.content)
    if (first !== undefined) {
      findings.push(finding(
        'header-cell-duplicate',
        `Header "${evidenceOf(cell.content)}" repeats column ${first + 1}.`,
        { file, pointer, line: table.header.line, column: cell.column },
        { suggestion: 'Use a distinct heading so the columns can be told apart.' },
      ))
      continue
    }
    seen.set(cell.content, column)
  }
}

function checkPipeStyle(table, file, findings) {
  const expected = `${table.header.leadingPipe}:${table.header.trailingPipe}`
  for (const row of [table.delimiter, ...table.rows]) {
    if (`${row.leadingPipe}:${row.trailingPipe}` === expected) continue
    findings.push(finding(
      'pipe-style-inconsistent',
      'This row does not use the same outer pipes as the header row, which makes an accidentally missing cell hard to see.',
      { file, pointer: `/tables/${table.index}`, line: row.line, column: 1 },
      { evidence: evidenceOf(row.text), suggestion: 'Use the same leading and trailing pipes on every row of the table.' },
    ))
    return
  }
}

function checkConstraints(table, config, file, findings) {
  const headerCells = effectiveCells(table.header, table.columnCount)
  const headings = headerCells.map((cell) => cell.content)

  for (const required of config.requiredColumns) {
    if (headings.includes(required)) continue
    findings.push(finding(
      'column-missing',
      `This table does not have the required column "${evidenceOf(required)}".`,
      { file, pointer: `/tables/${table.index}/header`, line: table.header.line, column: 1 },
      { suggestion: `Add a "${required}" column, or remove it from requiredColumns.` },
    ))
  }

  for (let column = 0; column < headings.length; column += 1) {
    const rule = config.columns[headings[column]]
    if (rule === undefined) continue

    if (rule.alignment !== undefined && table.alignments[column] !== rule.alignment) {
      const marker = table.delimiter.cells[column]
      findings.push(finding(
        'column-alignment-unexpected',
        `Column "${evidenceOf(headings[column])}" is aligned ${table.alignments[column]} but the configuration expects ${rule.alignment}.`,
        {
          file,
          pointer: `/tables/${table.index}/delimiter/cells/${column}`,
          line: table.delimiter.line,
          column: marker === undefined ? 1 : marker.column,
        },
        { suggestion: 'Adjust the colons in the delimiter row.' },
      ))
    }

    const seen = new Map()
    for (let position = 0; position < table.rows.length; position += 1) {
      const row = table.rows[position]
      const cell = effectiveCells(row, table.columnCount)[column]
      if (cell === undefined) continue
      const pointer = `/tables/${table.index}/rows/${position}/cells/${column}`
      const where = { file, pointer, line: row.line, column: cell.column }

      if (cell.content === '') {
        if (rule.required === true) {
          findings.push(finding(
            'cell-required-empty',
            `Column "${evidenceOf(headings[column])}" is required but this cell is empty.`,
            where,
            { suggestion: 'Fill the cell, or relax the constraint.' },
          ))
        }
        continue
      }

      if (rule.allowedValues !== undefined && !rule.allowedValues.includes(cell.content)) {
        findings.push(finding(
          'cell-value-not-allowed',
          `Column "${evidenceOf(headings[column])}" allows only: ${rule.allowedValues.join(', ')}.`,
          where,
          { evidence: evidenceOf(cell.content), suggestion: 'Use one of the allowed values.' },
        ))
      }
      if (rule.regexp !== undefined && !rule.regexp.test(cell.content)) {
        findings.push(finding(
          'cell-pattern-mismatch',
          `Column "${evidenceOf(headings[column])}" must match ${rule.pattern}.`,
          where,
          { evidence: evidenceOf(cell.content), suggestion: 'Rewrite the cell to match the configured pattern.' },
        ))
      }
      if (rule.maxLength !== undefined && codePoints(cell.content).length > rule.maxLength) {
        findings.push(finding(
          'cell-too-long',
          `Column "${evidenceOf(headings[column])}" allows ${rule.maxLength} characters; this cell has ${codePoints(cell.content).length}.`,
          where,
          { evidence: evidenceOf(cell.content), suggestion: 'Shorten the cell, or move the detail out of the table.' },
        ))
      }
      if (rule.unique === true) {
        const first = seen.get(cell.content)
        if (first !== undefined) {
          findings.push(finding(
            'cell-value-duplicate',
            `Column "${evidenceOf(headings[column])}" must be unique; this repeats the value on line ${first}.`,
            where,
            { evidence: evidenceOf(cell.content), suggestion: 'Give this row a distinct value.' },
          ))
        } else {
          seen.set(cell.content, row.line)
        }
      }
    }
  }
}

function reportProblem(problem, file, findings) {
  if (problem.kind === 'delimiter-row-invalid') {
    findings.push(finding(
      'delimiter-row-invalid',
      `"${evidenceOf(problem.detail)}" is not a delimiter cell, so this block does not render as a table.`,
      { file, pointer: '/document', line: problem.line, column: problem.column },
      {
        evidence: evidenceOf(problem.text),
        suggestion: 'Every delimiter cell must be dashes with optional colons, such as ---, :---, ---: or :---:.',
      },
    ))
    return
  }
  findings.push(finding(
    'header-delimiter-count-mismatch',
    `The delimiter row has ${problem.delimiterCount} cell(s) but the header on line ${problem.headerLine} has ${problem.headerCount}, so this block does not render as a table.`,
    { file, pointer: '/document', line: problem.line, column: problem.column },
    { evidence: evidenceOf(problem.text), suggestion: `Write ${problem.headerCount} delimiter cell(s).` },
  ))
}

function sortFindings(findings) {
  findings.sort((left, right) => byCodeUnit(left.location.file, right.location.file)
    || left.line - right.line
    || left.column - right.column
    || byCodeUnit(left.ruleId, right.ruleId)
    || byCodeUnit(left.location.pointer, right.location.pointer)
    || byCodeUnit(left.message, right.message))
  return findings
}

/**
 * Validate already-loaded documents.
 *
 * `documents` is an ordered list of `{ file, text }`. The order comes from the
 * caller, never from the filesystem, so the report does not depend on how a
 * directory happens to enumerate.
 */
export function validateDocuments(documents, options = {}) {
  const config = options.config ?? EMPTY_CONFIG
  const limits = { ...config.limits, ...(options.limits ?? {}) }
  const failures = options.failures ?? []
  const findings = []
  const previews = []
  let incomplete = false
  let tableCount = 0
  let rowCount = 0

  for (const failure of failures) {
    incomplete = true
    findings.push(finding(
      failure.ruleId,
      failure.message,
      { file: failure.file, pointer: '/document', line: 1, column: 1 },
      { suggestion: 'Provide a readable UTF-8 Markdown file, or remove it from the input list.' },
    ))
  }

  for (const document of documents) {
    let parsed
    try {
      parsed = parseTables(document.text, { limits, clock: options.clock })
    } catch (error) {
      if (!(error instanceof LimitExceeded)) throw error
      incomplete = true
      findings.push(finding(
        'limit-exceeded',
        `The ${error.limit} limit of ${error.allowed} was exceeded (observed ${error.observed}); this file was not fully checked.`,
        { file: document.file, pointer: '/document', line: error.line ?? 1, column: 1 },
        { suggestion: `Split the file, or raise "${error.limit}" in the configuration.` },
      ))
      continue
    }

    for (const problem of parsed.problems) reportProblem(problem, document.file, findings)

    for (const table of parsed.tables) {
      tableCount += 1
      rowCount += table.rows.length
      checkRowShape(table.header, table, -1, document.file, findings)
      checkRowShape(table.delimiter, table, -1, document.file, findings)
      for (let position = 0; position < table.rows.length; position += 1) {
        checkRowShape(table.rows[position], table, position, document.file, findings)
      }
      checkHeader(table, document.file, findings)
      checkPipeStyle(table, document.file, findings)
      if (table.rows.length === 0) {
        findings.push(finding(
          'table-has-no-data-rows',
          'This table has a header and a delimiter row but no data rows.',
          { file: document.file, pointer: `/tables/${table.index}`, line: table.startLine, column: 1 },
          { suggestion: 'Add the rows, or remove the empty table.' },
        ))
      }
      checkConstraints(table, config, document.file, findings)
    }

    const preview = renderDocumentPreview(parsed)
    previews.push({ file: document.file, text: preview.text, formatted: preview.formatted })
    for (const skipped of preview.skipped) {
      findings.push(finding(
        'preview-unavailable',
        `The formatting preview left this table unchanged: ${skipped.reason}.`,
        { file: document.file, pointer: `/tables/${skipped.table.index}`, line: skipped.table.startLine, column: 1 },
        { suggestion: 'Fix the reported problems in this table and run the preview again.' },
      ))
    }
  }

  sortFindings(findings)
  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.filter((item) => item.severity === 'warning').length

  return {
    report: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      tool: TOOL_ID,
      status: incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass',
      summary: {
        checked: tableCount,
        errors,
        warnings,
        info: findings.length - errors - warnings,
        files: documents.length + failures.length,
        filesRead: documents.length,
        tables: tableCount,
        rows: rowCount,
      },
      findings,
    },
    previews,
  }
}

const NUL = String.fromCharCode(0)

/**
 * A strict UTF-8 decoder.
 *
 * `fatal` is what makes the honesty promise hold: invalid bytes throw instead
 * of being replaced by U+FFFD, so a file that legitimately contains U+FFFD is
 * still read exactly, and a file whose bytes cannot be decoded is never read as
 * if they could. `ignoreBOM` keeps a leading U+FEFF in the text so it is
 * stripped in one place below.
 */
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Decode bytes as UTF-8 exactly, or `null` when they are not UTF-8. */
function decodeUtf8(bytes) {
  try {
    return UTF8_STRICT.decode(bytes)
  } catch {
    return null
  }
}

/**
 * Read the given paths, in the given order.
 *
 * The tool never walks a directory: every input is named explicitly, so nothing
 * about the report depends on filesystem enumeration order. A file that cannot
 * be read, cannot be decoded as UTF-8, or carries NUL bytes becomes a failure
 * the caller reports as `incomplete` -- never a quietly skipped input. Decoding
 * is strict, so a document that genuinely contains U+FFFD is checked normally
 * while one whose bytes are not UTF-8 is always reported.
 *
 * The two directories do different jobs and never trade places. `cwd` (default
 * `process.cwd()`) resolves a relative input path; `root` (default `cwd`) is
 * only the directory reported paths are made relative to. Naming a `root` can
 * therefore never change which file is read.
 */
export async function readDocuments(paths, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  const cwd = resolve(options.cwd ?? process.cwd())
  const root = resolve(options.root ?? cwd)
  if (paths.length > limits.maxFiles) {
    throw new LimitExceeded('maxFiles', limits.maxFiles, paths.length)
  }

  const documents = []
  const failures = []
  for (const path of paths) {
    const absolute = resolve(cwd, path)
    const file = relative(root, absolute).split(sep).join('/') || path
    try {
      const stats = await stat(absolute)
      if (!stats.isFile()) throw new Error('not a regular file')
      if (stats.size > limits.maxBytes) {
        failures.push({
          file,
          ruleId: 'limit-exceeded',
          message: `The maxBytes limit of ${limits.maxBytes} was exceeded (observed ${stats.size}); this file was not read.`,
        })
        continue
      }
      const decoded = decodeUtf8(await readFile(absolute))
      if (decoded === null) {
        failures.push({
          file,
          ruleId: 'input-not-utf8',
          message: 'This file is not valid UTF-8, so its contents could not be read exactly.',
        })
        continue
      }
      const text = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded
      if (text.includes(NUL)) {
        failures.push({
          file,
          ruleId: 'input-not-text',
          message: 'This file contains NUL bytes, so it is not a Markdown document.',
        })
        continue
      }
      documents.push({ file, absolute, text })
    } catch (error) {
      failures.push({ file, ruleId: 'input-unreadable', message: `This file could not be read: ${error.message}.` })
    }
  }

  return { root, documents, failures }
}

/** A short human summary. The JSON report is the machine-readable output. */
export function formatReport(report) {
  const lines = report.findings.map((item) => `${item.location.file}:${item.line}:${item.column} `
    + `${item.severity.padEnd(7)} ${item.ruleId} ${item.message}`)
  if (lines.length > 0) lines.push('')
  lines.push(`${report.summary.tables} table(s) with ${report.summary.rows} data row(s) `
    + `in ${report.summary.filesRead} of ${report.summary.files} file(s): `
    + `${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info, `
    + `status ${report.status}.`)
  return `${lines.join('\n')}\n`
}
