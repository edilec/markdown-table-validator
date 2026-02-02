import assert from 'node:assert/strict'
import test from 'node:test'

import { alignmentOf, codeSpanMask, parseTables, splitRow, unescapePipes } from '../src/index.mjs'

test('an escaped pipe stays inside its cell and becomes a literal pipe', () => {
  const row = splitRow('| a \\| b | c |')
  assert.deepEqual(row.cells.map((cell) => cell.content), ['a | b', 'c'])
  assert.deepEqual(row.cells.map((cell) => cell.raw), ['a \\| b', 'c'])
  assert.equal(row.codeSpanPipes.length, 0)
  assert.equal(row.leadingPipe, true)
  assert.equal(row.trailingPipe, true)
})

test('a raw pipe inside a code span splits the row, and is reported as such', () => {
  const row = splitRow('| a | `x|y` |')
  assert.deepEqual(row.cells.map((cell) => cell.content), ['a', '`x', 'y`'])
  assert.deepEqual(row.intentCells.map((cell) => cell.content), ['a', '`x|y`'])
  assert.deepEqual(row.codeSpanPipes, ['| a | `x'.length])
})

test('an escaped pipe inside a code span does not split the row', () => {
  const row = splitRow('| a | `x\\|y` |')
  assert.deepEqual(row.cells.map((cell) => cell.content), ['a', '`x|y`'])
  assert.deepEqual(row.cells.map((cell) => cell.raw), ['a', '`x\\|y`'])
  assert.equal(row.codeSpanPipes.length, 0)
})

test('an unclosed backtick run does not protect anything', () => {
  const mask = codeSpanMask('a `b | c')
  assert.equal([...mask].reduce((total, value) => total + value, 0), 0)
  const row = splitRow('a `b | c')
  assert.deepEqual(row.cells.map((cell) => cell.content), ['a `b', 'c'])
})

test('double backticks close on a run of the same length', () => {
  const row = splitRow('| ``a | b`` | c |')
  assert.deepEqual(row.cells.map((cell) => cell.content), ['``a', 'b``', 'c'])
  assert.deepEqual(row.intentCells.map((cell) => cell.content), ['``a | b``', 'c'])
})

test('rows without outer pipes keep every cell', () => {
  const row = splitRow('a | b | c')
  assert.deepEqual(row.cells.map((cell) => cell.content), ['a', 'b', 'c'])
  assert.equal(row.leadingPipe, false)
  assert.equal(row.trailingPipe, false)
})

test('only escaped pipes survive unescaping', () => {
  assert.equal(unescapePipes('a \\| b \\* c'), 'a | b \\* c')
})

test('the delimiter row declares alignment', () => {
  const { tables } = parseTables([
    '| a | b | c | d |',
    '| :-- | :-: | --: | --- |',
    '| 1 | 2 | 3 | 4 |',
  ].join('\n'))
  assert.equal(tables.length, 1)
  assert.deepEqual(tables[0].alignments, ['left', 'center', 'right', 'none'])
  assert.deepEqual([alignmentOf(':-'), alignmentOf(':')], ['left', 'left'])
})

test('every row carries its exact 1-based line number', () => {
  const { tables } = parseTables([
    '# Title',
    '',
    'text',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '| 3 | 4 |',
    '',
    'after',
  ].join('\n'))
  assert.equal(tables.length, 1)
  const table = tables[0]
  assert.equal(table.header.line, 5)
  assert.equal(table.delimiter.line, 6)
  assert.deepEqual(table.rows.map((row) => row.line), [7, 8])
  assert.equal(table.startLine, 5)
  assert.equal(table.endLine, 8)
})

test('a table inside a fenced code block is not a table', () => {
  const { tables, problems } = parseTables([
    '```markdown',
    '| a | b |',
    '| - | - |',
    '```',
    '~~~',
    '| c | d |',
    '| - | - |',
    '~~~',
  ].join('\n'))
  assert.equal(tables.length, 0)
  assert.equal(problems.length, 0)
})

test('an invalid delimiter cell is reported at its exact line and column', () => {
  const { tables, problems } = parseTables([
    '| a | b |',
    '| --- | -x- |',
  ].join('\n'))
  assert.equal(tables.length, 0)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, 'delimiter-row-invalid')
  assert.equal(problems[0].line, 2)
  assert.equal(problems[0].column, '| --- | '.length + 1)
})

test('a delimiter row with the wrong number of cells is reported, not parsed', () => {
  const { tables, problems } = parseTables(['| a | b | c |', '| --- | --- |'].join('\n'))
  assert.equal(tables.length, 0)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, 'header-delimiter-count-mismatch')
  assert.deepEqual([problems[0].headerCount, problems[0].delimiterCount], [3, 2])
})

test('a setext heading is not mistaken for a delimiter row', () => {
  const { tables, problems } = parseTables(['Some | heading', '---', '', 'text'].join('\n'))
  assert.equal(tables.length, 0)
  assert.equal(problems.length, 0)
})

test('a blank line ends the table', () => {
  const { tables } = parseTables([
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '| 3 | 4 |',
  ].join('\n'))
  assert.equal(tables.length, 1)
  assert.equal(tables[0].rows.length, 1)
})

test('CRLF input is read the same way as LF input', () => {
  const lf = parseTables(['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n'))
  const crlf = parseTables(['| a | b |', '| - | - |', '| 1 | 2 |'].join('\r\n'))
  assert.deepEqual(
    crlf.tables[0].rows.map((row) => row.cells.map((cell) => cell.content)),
    lf.tables[0].rows.map((row) => row.cells.map((cell) => cell.content)),
  )
})
