import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LimitExceeded,
  RULES,
  parseConfig,
  readDocuments,
  renderDocumentPreview,
  parseTables,
  validateDocuments,
} from '../src/index.mjs'

const POLICY = parseConfig({
  schemaVersion: '1',
  requiredColumns: ['Name', 'Status'],
  columns: {
    Name: { required: true, unique: true, pattern: '^[A-Z][A-Za-z0-9 ]*$' },
    Status: { required: true, allowedValues: ['stable', 'beta'], alignment: 'center' },
    Notes: { maxLength: 20 },
  },
})

function run(text, options = {}) {
  return validateDocuments([{ file: 'doc.md', text }], options)
}

function ruleIds(report) {
  return report.findings.map((item) => `${item.ruleId}@${item.line}:${item.column}`)
}

test('a well-formed table with escaped pipes and code spans passes', () => {
  const { report } = run([
    '| Name | Status | Notes      |',
    '| ---- | :----: | ---------- |',
    '| Csv  | stable | a \\| b     |',
    '| Tsv  | beta   | `x\\|y`     |',
  ].join('\n'), { config: POLICY })
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.summary, {
    checked: 1, errors: 0, warnings: 0, info: 0, files: 1, filesRead: 1, tables: 1, rows: 2,
  })
})

test('a malformed row names its exact line, and says what GFM will do with it', () => {
  const { report } = run([
    '| a | b | c |',
    '| - | - | - |',
    '| 1 | 2 | 3 |',
    '| 1 | 2 | 3 | 4 |',
    '| 1 | 2 |',
  ].join('\n'))
  const mismatches = report.findings.filter((item) => item.ruleId === 'column-count-mismatch')
  assert.deepEqual(mismatches.map((item) => item.line), [4, 5])
  assert.match(mismatches[0].message, /drops the 1 extra cell/)
  assert.match(mismatches[1].message, /renders 1 trailing empty cell/)
  assert.equal(report.status, 'fail')
})

test('a raw pipe in a code span is an error at the pipe, not a column-count complaint', () => {
  const { report } = run([
    '| Name | Status | Notes  |',
    '| ---- | :----: | ------ |',
    '| Csv  | stable | `a|b`  |',
  ].join('\n'), { config: POLICY })
  assert.deepEqual(ruleIds(report), [
    'preview-unavailable@1:1',
    'pipe-in-code-span@3:21',
  ])
  const pipe = report.findings[1]
  assert.equal(pipe.location.pointer, '/tables/0/rows/0')
  assert.match(pipe.suggestion, /\\\|/)
  assert.equal(pipe.evidence, '| Csv  | stable | `a|b`  |')
})

test('configured content constraints report the offending cell', () => {
  const { report } = run([
    '| Name | Status | Notes                          |',
    '| ---- | :----: | ------------------------------ |',
    '| Csv  | stable | short                          |',
    '| csv  | shaky  | a note that is definitely long |',
    '| Csv  |        | short                          |',
  ].join('\n'), { config: POLICY })
  assert.deepEqual(ruleIds(report), [
    'cell-pattern-mismatch@4:3',
    'cell-value-not-allowed@4:10',
    'cell-too-long@4:19',
    'cell-value-duplicate@5:3',
    'cell-required-empty@5:9',
  ])
})

test('a missing required column and a broken header are reported once each', () => {
  const { report } = run([
    '| Name | Name |    |',
    '| ---- | ---- | -- |',
    '| Csv  | Tsv  | .. |',
  ].join('\n'), { config: POLICY })
  assert.deepEqual(ruleIds(report), [
    'column-missing@1:1',
    'header-cell-duplicate@1:10',
    'header-cell-empty@1:16',
  ])
})

test('an unexpected alignment is reported on the delimiter row', () => {
  const { report } = run([
    '| Name | Status |',
    '| ---- | -----: |',
    '| Csv  | stable |',
  ].join('\n'), { config: POLICY })
  assert.deepEqual(ruleIds(report), ['column-alignment-unexpected@2:10'])
  assert.equal(report.findings[0].severity, 'warning')
  assert.equal(report.status, 'pass')
})

test('an empty table and an inconsistent pipe style are warnings', () => {
  const { report } = run([
    '| a | b |',
    '| - | - |',
    '',
    '| c | d |',
    '| - | - |',
    'x | y',
  ].join('\n'))
  assert.deepEqual(ruleIds(report), ['table-has-no-data-rows@1:1', 'pipe-style-inconsistent@6:1'])
  assert.equal(report.status, 'pass')
})

test('the preview preserves cell content exactly and never touches the input', () => {
  const text = [
    '| Name | Notes  |',
    '|---|---|',
    '| Csv | a \\| b |',
    '| Tsv | `x\\|y` |',
  ].join('\n')
  const parsed = parseTables(text)
  const preview = renderDocumentPreview(parsed)
  assert.notEqual(preview.text, text)
  assert.equal(preview.formatted, 1)
  assert.deepEqual(preview.skipped, [])

  const before = parsed.tables[0]
  const after = parseTables(preview.text).tables[0]
  assert.deepEqual(
    after.rows.map((row) => row.cells.map((cell) => [cell.raw, cell.content])),
    before.rows.map((row) => row.cells.map((cell) => [cell.raw, cell.content])),
  )
  assert.deepEqual(after.alignments, before.alignments)
  assert.equal(after.rows[1].cells[1].content, '`x|y`')
})

test('a table that cannot be reformatted safely is copied through untouched', () => {
  const text = ['| a | b |', '| - | - |', '| 1 | 2 | 3 |'].join('\n')
  const preview = renderDocumentPreview(parseTables(text))
  assert.equal(preview.text, text)
  assert.equal(preview.formatted, 0)
  assert.equal(preview.skipped.length, 1)
  const { report } = run(text)
  const unavailable = report.findings.filter((item) => item.ruleId === 'preview-unavailable')
  assert.equal(unavailable.length, 1)
  assert.equal(unavailable[0].severity, 'info')
})

test('an unreadable input is incomplete, never a pass', () => {
  const { report } = validateDocuments([], {
    failures: [{ file: 'missing.md', ruleId: 'input-unreadable', message: 'This file could not be read: ENOENT.' }],
  })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.files, 1)
  assert.equal(report.summary.filesRead, 0)
  assert.equal(report.findings[0].ruleId, 'input-unreadable')
})

test('exceeding a limit is an explicit finding, never a silent truncation', () => {
  const text = ['| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |'].join('\n')
  const { report } = run(text, { limits: { maxRowsPerTable: 1 } })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.tables, 0)
  assert.deepEqual(ruleIds(report), ['limit-exceeded@4:1'])
  assert.match(report.findings[0].message, /maxRowsPerTable limit of 1/)
})

test('every declared bound is enforced and named', () => {
  const table = ['| a | b |', '| - | - |', '| 1 | 2 |']
  const cases = [
    { limits: { maxLines: 2 }, text: table.join('\n'), limit: 'maxLines' },
    { limits: { maxLineLength: 5 }, text: table.join('\n'), limit: 'maxLineLength' },
    { limits: { maxColumns: 1 }, text: table.join('\n'), limit: 'maxColumns' },
    { limits: { maxRowsPerTable: 1 }, text: [...table, '| 3 | 4 |'].join('\n'), limit: 'maxRowsPerTable' },
    { limits: { maxTables: 1 }, text: [...table, '', ...table].join('\n'), limit: 'maxTables' },
  ]
  for (const example of cases) {
    const { report } = run(example.text, { limits: example.limits })
    assert.equal(report.status, 'incomplete', example.limit)
    assert.deepEqual(report.findings.map((item) => item.ruleId), ['limit-exceeded'], example.limit)
    assert.ok(report.findings[0].message.startsWith(`The ${example.limit} limit of`), report.findings[0].message)
  }
})

test('the injected clock bounds how long a document may take', () => {
  let ticks = 0
  const clock = () => {
    ticks += 1
    return ticks * 1000
  }
  const { report } = run(['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n'), {
    limits: { timeLimitMs: 1 },
    clock,
  })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].ruleId, 'limit-exceeded')
  assert.match(report.findings[0].message, /timeLimitMs/)
})

test('evidence escapes control characters instead of printing them', () => {
  const control = String.fromCharCode(0x7f)
  const backslash = String.fromCharCode(92)
  const { report } = run([
    '| a | b |',
    '| - | - |',
    `| 1${control} | 2 | 3 |`,
  ].join('\n'))
  const mismatch = report.findings.find((item) => item.ruleId === 'column-count-mismatch')
  assert.equal(mismatch.evidence, `| 1${backslash}u007f | 2 | 3 |`)
  assert.ok(!mismatch.evidence.includes(control))
  assert.ok(report.findings.every((item) => item.evidence === undefined || !item.evidence.includes(control)))
})

test('reading names each input failure without ever walking a directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'markdown-table-validator-'))
  try {
    await writeFile(join(directory, 'big.md'), '| a | b |\n| - | - |\n', 'utf8')
    await writeFile(join(directory, 'bad.md'), Buffer.from([0x7c, 0xff, 0x7c]))
    await writeFile(join(directory, 'bom.md'), `\uFEFF| a | b |\n| - | - |\n| 1 | 2 |\n`, 'utf8')

    const strict = await readDocuments(['big.md'], { root: directory, limits: { maxBytes: 10 } })
    assert.deepEqual(strict.documents, [])
    assert.equal(strict.failures[0].ruleId, 'limit-exceeded')
    assert.match(strict.failures[0].message, /maxBytes limit of 10/)

    const decoded = await readDocuments(['bad.md', 'missing.md'], { root: directory })
    assert.deepEqual(decoded.failures.map((failure) => failure.ruleId), ['input-not-utf8', 'input-unreadable'])
    assert.deepEqual(decoded.failures.map((failure) => failure.file), ['bad.md', 'missing.md'])

    const bom = await readDocuments(['bom.md'], { root: directory })
    assert.deepEqual(bom.failures, [])
    assert.equal(parseTables(bom.documents[0].text).tables.length, 1)

    await assert.rejects(
      readDocuments(['bom.md', 'big.md'], { root: directory, limits: { maxFiles: 1 } }),
      (error) => error instanceof LimitExceeded && error.limit === 'maxFiles',
    )

    const { report } = validateDocuments(bom.documents, { failures: decoded.failures })
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.files, 3)
    assert.equal(report.summary.filesRead, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an invalid configuration is a usage error, not a default', () => {
  assert.throws(() => parseConfig({ schemaVersion: '2' }), /schemaVersion/)
  assert.throws(() => parseConfig({ schemaVersion: '1', unknown: 1 }), /Unknown configuration key/)
  assert.throws(() => parseConfig({ schemaVersion: '1', columns: { A: { nope: 1 } } }), /Unknown constraint/)
  assert.throws(() => parseConfig({ schemaVersion: '1', columns: { A: { pattern: '(' } } }), /not a valid regular expression/)
  assert.throws(() => parseConfig({ schemaVersion: '1', columns: { A: { maxLength: 0 } } }), /positive integer/)
  assert.throws(() => parseConfig({ schemaVersion: '1', limits: { nope: 5 } }), /Unknown limit/)
  assert.throws(() => parseConfig({ schemaVersion: '1', requiredColumns: 'Name' }), /array of strings/)
  assert.throws(() => parseConfig(null), /JSON object/)
})

test('findings are sorted by file, line, column then rule id', () => {
  const text = ['| a | a |', '| - | - |', '| 1 | 2 | 3 |'].join('\n')
  const { report } = validateDocuments([
    { file: 'b.md', text },
    { file: 'a.md', text },
  ])
  const order = report.findings.map((item) => [item.location.file, item.line, item.column, item.ruleId])
  const sorted = [...order].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
    || left[1] - right[1] || left[2] - right[2] || (left[3] < right[3] ? -1 : left[3] > right[3] ? 1 : 0))
  assert.deepEqual(order, sorted)
})

test('the same input produces a byte-identical report twice', () => {
  const text = [
    '| Name | Status | Notes                          |',
    '| ---- | -----: | ------------------------------ |',
    '| Csv  | stable | a \\| b                         |',
    '| csv  | shaky  | a note that is definitely long |',
    '| Csv  | stable | `a|b`                          |',
    '| Csv  |',
  ].join('\n')
  const first = run(text, { config: POLICY })
  const second = run(text, { config: POLICY })
  assert.equal(JSON.stringify(first.report), JSON.stringify(second.report))
  assert.equal(first.previews[0].text, second.previews[0].text)
  assert.ok(first.report.findings.length > 5)
})

test('every emitted rule id is declared in the catalog with its severity', () => {
  const text = ['| a | a |', '| - | - |', '| 1 | 2 | 3 |'].join('\n')
  const { report } = run(text, { config: POLICY })
  for (const item of report.findings) {
    assert.equal(item.severity, RULES[item.ruleId], `severity for ${item.ruleId}`)
  }
})
