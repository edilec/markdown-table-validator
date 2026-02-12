import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTables } from '../src/index.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI = fileURLToPath(new URL('../bin/markdown-table-validator.mjs', import.meta.url))

function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: ROOT }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : error.code, stdout, stderr })
    })
  })
}

function cells(text) {
  return parseTables(text).tables.map((table) => [
    table.header.cells.map((cell) => cell.raw),
    ...table.rows.map((row) => row.cells.map((cell) => cell.raw)),
  ])
}

test('--help explains the tool and exits 0', async () => {
  const result = await cli(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /markdown-table-validator/)
  assert.match(result.stdout, /--preview-dir/)
  assert.equal(result.stderr, '')
})

test('the clean example passes and exits 0', async () => {
  const result = await cli(['--config', 'examples/table-policy.json', 'examples/clean.md'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /status pass/)
})

test('--json puts a parseable report on stdout and nothing else', async () => {
  const result = await cli(['--config', 'examples/table-policy.json', '--json', 'examples/clean.md'])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'markdown-table-validator')
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.tables, 2)
})

test('the broken example fails with exact lines and exits 1', async () => {
  const result = await cli(['--config', 'examples/table-policy.json', '--json', 'examples/broken.md'])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'fail')
  const located = report.findings.map((item) => `${item.ruleId}@${item.location.file}:${item.line}`)
  for (const expected of [
    'column-count-mismatch@examples/broken.md:8',
    'column-count-mismatch@examples/broken.md:9',
    'pipe-in-code-span@examples/broken.md:17',
    'delimiter-row-invalid@examples/broken.md:22',
    'header-delimiter-count-mismatch@examples/broken.md:28',
    'column-missing@examples/broken.md:32',
    'pipe-style-inconsistent@examples/broken.md:41',
  ]) assert.ok(located.includes(expected), `missing ${expected}`)
})

test('two runs over the same input produce byte-identical output', async () => {
  const args = ['--config', 'examples/table-policy.json', '--json', 'examples/broken.md', 'examples/clean.md']
  const first = await cli(args)
  const second = await cli(args)
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
  assert.ok(first.stdout.length > 500)
})

test('the preview is a derived copy that preserves every cell, and the input is untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'markdown-table-validator-'))
  try {
    const before = await readFile(join(ROOT, 'examples/clean.md'), 'utf8')
    const result = await cli([
      '--config', 'examples/table-policy.json',
      '--preview-dir', directory,
      'examples/clean.md',
    ])
    assert.equal(result.code, 0)
    assert.match(result.stderr, /preview written/)

    const preview = await readFile(join(directory, 'examples/clean.md'), 'utf8')
    assert.notEqual(preview, before)
    assert.deepEqual(cells(preview), cells(before))
    assert.ok(preview.includes('| `\\|`      |'), 'the escaped pipe in a code span survives')

    const after = await readFile(join(ROOT, 'examples/clean.md'), 'utf8')
    assert.equal(after, before)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the preview refuses to write over the input it was derived from', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'markdown-table-validator-'))
  try {
    const path = join(directory, 'doc.md')
    const source = ['| a | b |', '| - | - |', '| 1 | 2 |', ''].join('\n')
    await writeFile(path, source, 'utf8')
    const result = await cli(['--root', directory, '--preview-dir', directory, path])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Refusing to overwrite the input file doc\.md/)
    assert.equal(await readFile(path, 'utf8'), source)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an unreadable input is incomplete and exits 2', async () => {
  const result = await cli(['--json', 'examples/does-not-exist.md'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.filesRead, 0)
  assert.equal(report.findings[0].ruleId, 'input-unreadable')
  assert.equal(report.findings[0].location.file, 'examples/does-not-exist.md')
})

test('an input that is not text is incomplete, never a pass', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'markdown-table-validator-'))
  try {
    const path = join(directory, 'binary.md')
    await writeFile(path, `| a | b |${String.fromCharCode(0)}| - | - |`, 'utf8')
    const result = await cli(['--json', '--root', directory, path])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings[0].ruleId, 'input-not-text')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a file whose bytes are not UTF-8 is incomplete even when it also contains U+FFFD', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'markdown-table-validator-'))
  try {
    const path = join(directory, 'mixed.md')
    const previews = join(directory, 'preview')
    await writeFile(path, Buffer.concat([
      Buffer.from('| a | b |\n| - | - |\n| 1 | ', 'utf8'),
      Buffer.from([0xff]),
      Buffer.from(` ${String.fromCharCode(0xfffd)} |\n`, 'utf8'),
    ]))
    const result = await cli(['--json', '--root', directory, '--preview-dir', previews, path])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.filesRead, 0)
    assert.equal(report.findings[0].ruleId, 'input-not-utf8')
    assert.doesNotMatch(result.stderr, /preview written/)
    await assert.rejects(readFile(join(previews, 'mixed.md'), 'utf8'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the command line enforces timeLimitMs against a real clock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'markdown-table-validator-'))
  try {
    const document = join(directory, 'big.md')
    const policy = join(directory, 'policy.json')
    const lines = []
    for (let index = 0; index < 20000; index += 1) lines.push(`prose | line - ${index}`)
    await writeFile(document, `${lines.join('\n')}\n`, 'utf8')
    await writeFile(policy, JSON.stringify({ schemaVersion: '1', limits: { timeLimitMs: 1 } }), 'utf8')

    const result = await cli(['--json', '--config', policy, '--root', directory, document])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings[0].ruleId, 'limit-exceeded')
    assert.match(report.findings[0].message, /timeLimitMs/)

    const generous = await cli(['--json', '--root', directory, document])
    assert.equal(generous.code, 0)
    assert.equal(JSON.parse(generous.stdout).status, 'pass')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an invalid configuration exits 2 with an empty stdout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'markdown-table-validator-'))
  try {
    const path = join(directory, 'policy.json')
    await writeFile(path, JSON.stringify({ schemaVersion: '1', columns: { Name: { nope: true } } }), 'utf8')
    const result = await cli(['--config', path, 'examples/clean.md'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Unknown constraint "nope" on column "Name"/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('usage errors exit 2 and print the help on stderr', async () => {
  const noFiles = await cli([])
  assert.equal(noFiles.code, 2)
  assert.equal(noFiles.stdout, '')
  assert.match(noFiles.stderr, /at least one Markdown file is required/)

  const unknown = await cli(['--nope', 'examples/clean.md'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.stderr, /Unknown option "--nope"/)
})
