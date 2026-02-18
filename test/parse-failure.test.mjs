import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseFailureDetail } from '../src/index.mjs'

/**
 * A configuration that cannot be parsed must not be republished by its own
 * diagnostic.
 *
 * V8 reports a parse failure two ways, and one of them quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. The quoted
 * run is the first ten characters of the document, or the whole document when
 * it is shorter, so a file short enough to be nothing but a credential is
 * reproduced in full by its own error message. `--config` interpolated that
 * message whole onto stderr -- on the error path, which is the path a
 * malformed or misnamed file is guaranteed to take.
 *
 * The canary is `AKIAIOSFODNN7EXAMPLE`, the access key id AWS publishes in its
 * own documentation. It is not a credential; it is the shape of one.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI = fileURLToPath(new URL('../bin/markdown-table-validator.mjs', import.meta.url))

const CANARY = 'AKIAIOSFODNN7EXAMPLE'

function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: ROOT }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : error.code, stdout, stderr })
    })
  })
}

/** Write a configuration of the caller's choosing, run the real binary over a clean document. */
async function withConfig(content, body) {
  const base = await mkdtemp(join(tmpdir(), 'markdown-table-validator-canary-'))
  try {
    const document = join(base, 'doc.md')
    const config = join(base, 'policy.json')
    await writeFile(document, '# Doc\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n', 'utf8')
    await writeFile(config, content, 'utf8')
    return await body(await cli(['--config', config, document]))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/**
 * Assert the canary is absent from both streams, and so is every prefix of it
 * down to eight characters. The prefixes matter because V8 quotes only the
 * first ten characters once the document is long enough: a test looking for
 * the whole canary would pass against a message still leaking `AKIAIOSFOD`.
 */
function assertNoCanary(result, label) {
  for (let length = CANARY.length; length >= 8; length -= 1) {
    const prefix = CANARY.slice(0, length)
    assert.equal(result.stdout.includes(prefix), false, `${label}: stdout carries ${prefix}`)
    assert.equal(result.stderr.includes(prefix), false, `${label}: stderr carries ${prefix}`)
  }
}

test('a configuration that is nothing but a credential is not echoed back', async () => {
  await withConfig(CANARY, (result) => {
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /not valid JSON/)
    assertNoCanary(result, 'whole document')
  })
})

test('a credential inside a longer configuration is not echoed either', async () => {
  await withConfig(`{"schemaVersion": "1", "columns": ${CANARY}}`, (result) => {
    assert.equal(result.code, 2)
    assertNoCanary(result, 'embedded in a document')
  })
})

test('the position, line and column survive -- a diagnostic that says nothing is a different defect', async () => {
  await withConfig('{"schemaVersion": "1" "columns": {}}', (result) => {
    assert.equal(result.code, 2)
    assert.match(result.stderr, /at position \d+ \(line \d+ column \d+\)/)
  })
})

test('a configuration that cannot be read still says which syscall failed', async () => {
  const result = await cli(['--config', 'examples/does-not-exist.json', 'examples/clean.md'])

  assert.equal(result.code, 2)
  assert.match(result.stderr, /Could not read configuration: ENOENT/)
})

test('parseFailureDetail keeps the offset and drops the quoted document', () => {
  const detailFor = (text) => {
    try {
      JSON.parse(text)
    } catch (error) {
      return parseFailureDetail(error)
    }
    throw new Error('the fixture parsed, so it pins nothing')
  }

  assert.equal(detailFor(CANARY), "unexpected token 'A' at the start of the document")
  assert.equal(detailFor('ssn 123-45-6789'), "unexpected token 's' at the start of the document")
  assert.equal(detailFor('password=hunter2-correct-horse'), "unexpected token 'p' at the start of the document")
  assert.equal(detailFor(`{"a": 1, "b": ${CANARY}}`), "unexpected token 'A' inside the document")
  assert.equal(detailFor(''), 'Unexpected end of JSON input')
  assert.equal(detailFor('{"a": 1 "b": 2}'), "Expected ',' or '}' after property value in JSON at position 8 (line 1 column 9)")
  assert.equal(detailFor('{"a": 1} trailing'), 'Unexpected non-whitespace character after JSON at position 9 (line 1 column 10)')
})

test('parseFailureDetail refuses a wording it was not taught rather than guessing', () => {
  assert.equal(
    parseFailureDetail(new Error('Unexpected token \'A\', "AKIAIOSFODNN7EXAMPLE" is not valid JSON at position 0')),
    'the document could not be parsed as JSON',
    'a double quote surviving to the end means the snippet survived with it',
  )
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
})

/**
 * The ORDER inside `parseFailureDetail` is the defence, and nothing above pins
 * it: every case above reaches the quoting branch whichever order the branches
 * are tried in. These do not.
 *
 * A document whose own text reads `at position 1` makes V8 write
 * `Unexpected token 'a', "at position 1" is not valid JSON`. Search for the
 * offset FIRST and it is found INSIDE the quoted span, and the slice hands the
 * document straight back out.
 */

const EXPECT_LOWER_A = "unexpected token 'a' at the start of the document"
const EXPECT_BRACE = "unexpected token '}' at the start of the document"
const GENERIC = 'the document could not be parsed as JSON'

/** The detail for a document that must not parse. */
function detailOf(document) {
  let thrown = null
  try {
    JSON.parse(document)
  } catch (error) {
    thrown = error
  }
  assert.notEqual(thrown, null, `${JSON.stringify(document)} was supposed to be unparseable`)
  return parseFailureDetail(thrown)
}

/** No prefix of `document` from four characters up survives into the detail. */
function assertNoPrefixOf(document, detail, label) {
  for (let length = Math.min(document.length, 40); length >= 4; length -= 1) {
    const prefix = document.slice(0, length)
    assert.equal(detail.includes(prefix), false, `${label}: the detail carries ${JSON.stringify(prefix)}`)
  }
}

test('a document whose own text reads "at position 1" does not smuggle itself out', () => {
  const detail = detailOf('at position 1')
  assert.equal(detail.includes('"'), false, `a quoted span survived: ${detail}`)
  assert.equal(detail.includes('at position 1'), false, `the document came back: ${detail}`)
  assert.equal(detail, EXPECT_LOWER_A)
})

test('a document that is nothing but a credential never appears in the detail', () => {
  const detail = detailOf(CANARY)
  assert.equal(detail.includes(CANARY), false, `the canary came back: ${detail}`)
  assertNoPrefixOf(CANARY, detail, 'credential-only document')
})

test('a long document does not leak the ten characters V8 quotes from its head', () => {
  const document = `${CANARY} followed by a great deal of content nobody should read back`
  const detail = detailOf(document)
  assertNoPrefixOf(document, detail, 'long document')
})

test('a quoted span carrying a newline is still recognised as the quoting shape', () => {
  // Without the `s` flag the quoting branch misses this message entirely and
  // the detail collapses to the generic sentence.
  const detail = detailOf('}x\n')
  assert.equal(detail.includes('"'), false, `a quoted span survived: ${detail}`)
  assert.equal(detail, EXPECT_BRACE)
})

test('the genuinely safe positional form keeps its position, line and column', () => {
  // A helper that answered the generic sentence for everything would pass every
  // leak case above while destroying every diagnostic. This is the pin.
  const detail = detailOf('{"a": 1 "b": 2}')
  assert.match(detail, /at position 8 \(line 1 column 9\)$/)
  assert.equal(detail.includes('"'), false, `a quoted span survived: ${detail}`)
  assert.notEqual(detail, GENERIC)
})

test('an empty document keeps V8 own words, unchanged', () => {
  assert.equal(detailOf(''), 'Unexpected end of JSON input')
})
