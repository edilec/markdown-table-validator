import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/markdown-table-validator.mjs', import.meta.url))

const DOCUMENT = ['| Name | Stage |', '| - | - |', '| Tsv Reader | beta |', ''].join('\n')

function cli(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : error.code, stdout, stderr })
    })
  })
}

/**
 * A scratch tree shaped like a real run: a root the caller works in, an input
 * inside it, and a directory outside the root holding the bystanders a bad
 * destination would reach.
 */
async function scratch() {
  const base = await mkdtemp(join(tmpdir(), 'markdown-table-validator-guard-'))
  await mkdir(join(base, 'root'), { recursive: true })
  await mkdir(join(base, 'outside'), { recursive: true })
  await writeFile(join(base, 'root', 'doc.md'), DOCUMENT, 'utf8')
  return base
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

test('a symbolic link at the destination is refused, and what it points at is untouched', async () => {
  const base = await scratch()
  try {
    const bystander = join(base, 'outside', 'bystander.md')
    await writeFile(bystander, 'BYSTANDER\n', 'utf8')
    await mkdir(join(base, 'root', 'pv'))
    await symlink(bystander, join(base, 'root', 'pv', 'doc.md'))

    const result = await cli(['--preview-dir', 'pv', 'doc.md'], join(base, 'root'))
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--preview-dir is a symbolic link/)
    assert.equal(await readFile(bystander, 'utf8'), 'BYSTANDER\n')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a symbolic link at the destination pointing nowhere yet creates no file outside', async () => {
  const base = await scratch()
  try {
    await mkdir(join(base, 'root', 'pv'))
    await symlink(join(base, 'outside', 'not-yet.md'), join(base, 'root', 'pv', 'doc.md'))

    const result = await cli(['--preview-dir', 'pv', 'doc.md'], join(base, 'root'))
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--preview-dir is a symbolic link/)
    assert.deepEqual(await readdir(join(base, 'outside')), [])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a --preview-dir that is itself a symbolic link out of the tree is refused', async () => {
  const base = await scratch()
  try {
    const landing = join(base, 'outside', 'landing')
    await mkdir(landing)
    await writeFile(join(landing, 'doc.md'), 'BYSTANDER\n', 'utf8')
    await symlink(landing, join(base, 'root', 'pv'))

    const result = await cli(['--preview-dir', 'pv', 'doc.md'], join(base, 'root'))
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--preview-dir is a symbolic link/)
    assert.equal(await readFile(join(landing, 'doc.md'), 'utf8'), 'BYSTANDER\n')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

/**
 * The ordering case. `mkdir(path, {recursive: true})` follows a symlinked
 * component, so a check that runs after it has already created directories
 * outside the tree. Nothing may exist under `outside/landing` when this
 * returns.
 */
test('a symlinked directory inside the preview directory is refused before any directory is created', async () => {
  const base = await scratch()
  try {
    await mkdir(join(base, 'root', 'docs', 'sub'), { recursive: true })
    await writeFile(join(base, 'root', 'docs', 'sub', 'doc.md'), DOCUMENT, 'utf8')
    const landing = join(base, 'outside', 'landing')
    await mkdir(landing)
    await mkdir(join(base, 'root', 'pv'))
    await symlink(landing, join(base, 'root', 'pv', 'docs'))

    const result = await cli(['--preview-dir', 'pv', join('docs', 'sub', 'doc.md')], join(base, 'root'))
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /is a symbolic link; a preview is never written through one/)
    assert.deepEqual(await readdir(landing), [])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a hard link to an input is refused: one device and inode is one file, whatever it is called', async () => {
  const base = await scratch()
  try {
    const input = join(base, 'root', 'doc.md')
    await mkdir(join(base, 'root', 'pv'))
    await link(input, join(base, 'root', 'pv', 'doc.md'))

    const result = await cli(['--preview-dir', 'pv', 'doc.md'], join(base, 'root'))
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /is the same file as an input/)
    assert.equal(await readFile(input, 'utf8'), DOCUMENT)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an input above the reporting root cannot push a preview out of the preview directory', async () => {
  const base = await scratch()
  try {
    const input = join(base, 'outside', 'above.md')
    await writeFile(input, DOCUMENT, 'utf8')

    const result = await cli([
      '--root', join(base, 'root'),
      '--preview-dir', join(base, 'root', 'pv'),
      input,
    ], base)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /which is outside/)
    assert.equal(await exists(join(base, 'root', 'outside')), false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

/**
 * The other half of the guard: it must still write the destinations it is for.
 * A guard that refuses everything passes every case above while making
 * `--preview-dir` useless. The scratch tree lives under the system temporary
 * directory, which on macOS is reached through a symlinked ancestor -- so this
 * also pins that an ancestor link, unlike a link on the named path, is allowed.
 */
test('the destinations previews are for still work: a new directory, a subdirectory, and a rerun', async () => {
  const base = await scratch()
  try {
    await mkdir(join(base, 'root', 'docs'))
    await writeFile(join(base, 'root', 'docs', 'nested.md'), DOCUMENT, 'utf8')

    const fresh = await cli(['--preview-dir', 'pv', 'doc.md'], join(base, 'root'))
    assert.equal(fresh.code, 0)
    assert.match(fresh.stderr, /preview written/)
    const first = await readFile(join(base, 'root', 'pv', 'doc.md'), 'utf8')
    assert.match(first, /\| Tsv Reader \| beta {2}\|/)

    const nested = await cli(['--preview-dir', 'pv', join('docs', 'nested.md')], join(base, 'root'))
    assert.equal(nested.code, 0)
    assert.equal(
      await readFile(join(base, 'root', 'pv', 'docs', 'nested.md'), 'utf8'),
      first,
    )

    const again = await cli(['--preview-dir', 'pv', 'doc.md'], join(base, 'root'))
    assert.equal(again.code, 0)
    assert.match(again.stderr, /preview written/)
    assert.equal(await readFile(join(base, 'root', 'pv', 'doc.md'), 'utf8'), first)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
