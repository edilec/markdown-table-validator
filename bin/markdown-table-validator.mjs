#!/usr/bin/env node

import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  LimitExceeded,
  formatReport,
  parseConfig,
  parseFailureDetail,
  readDocuments,
  validateDocuments,
} from '../src/index.mjs'
import { DestinationError, assertWritableDestination } from '../src/write-guard.mjs'

/**
 * The one clock in the tool.
 *
 * `timeLimitMs` is enforced against an injected clock so the library stays
 * deterministic; the command line injects the process monotonic clock here, and
 * the budget can only ever turn a run into an explicit `limit-exceeded`.
 */
const clock = () => performance.now()

const HELP = `markdown-table-validator

Validate Markdown tables: column shape, escaped separators, header structure,
alignment and configured content constraints.

Usage:
  markdown-table-validator [options] <file.md> [file.md ...]

Options:
  --config FILE       Content constraint configuration (JSON)
  --root DIR          Report paths relative to this directory (default: cwd)
  --preview-dir DIR   Write the derived formatting preview of each input here
  --json              Emit the machine-readable report on stdout
  -h, --help          Show this help

Inputs are read in the order given; no directory is ever walked, so the report
never depends on filesystem enumeration order. An input path is always resolved
against the current working directory: --root only changes the paths written
into the report. The preview is a derived copy: an
input file is never rewritten, and a table that cannot be reformatted without
risking its content is copied through untouched and reported.

Every preview is written under the real --preview-dir. A symbolic link on the
way to a destination, or at the destination itself, is refused rather than
followed, as is a destination that is the same file as an input -- a hard link
included. A refused destination is a configuration error: exit 2, empty stdout,
and nothing written.

Exit codes:
  0  every table satisfied the checks
  1  a table failed the checks
  2  invalid usage or configuration, or an input could not be read in full
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { config: null, root: null, previewDir: null, json: false, files: [] }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--config') options.config = takeValue('--config')
    else if (argument === '--root') options.root = takeValue('--root')
    else if (argument === '--preview-dir') options.previewDir = takeValue('--preview-dir')
    else if (argument.startsWith('-')) throw new Error(`Unknown option "${argument}"`)
    else options.files.push(argument)
  }

  if (options.files.length === 0) throw new Error('at least one Markdown file is required')
  return options
}

/**
 * The read and the parse fail separately on purpose. A filesystem error
 * describes the caller's own argument, but a parse error describes the file's
 * contents -- V8 quotes the input back in one of its two message shapes -- and
 * that must not reach stderr. `parseFailureDetail` keeps the offset and drops
 * the quoted half.
 */
async function loadConfig(path) {
  let raw
  try {
    raw = await readFile(resolve(path), 'utf8')
  } catch (error) {
    throw new Error(`Could not read configuration: ${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`The configuration is not valid JSON: ${parseFailureDetail(error)}.`)
  }
  return parseConfig(parsed)
}

/**
 * Open the directory the caller named, and refuse a link standing in for it.
 *
 * `--preview-dir` is the root every preview is written under, so it is checked
 * the way a destination is: a symbolic link here would put every preview
 * wherever the link points, which is not the directory the caller named. The
 * real path is returned, and every later comparison is made against it.
 */
async function openPreviewRoot(previewDir) {
  const target = resolve(previewDir)
  let existing = null
  try {
    existing = await lstat(target)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new DestinationError(`--preview-dir could not be inspected: ${error.code ?? 'unknown error'}`)
    }
  }
  if (existing !== null && existing.isSymbolicLink()) {
    throw new DestinationError(
      '--preview-dir is a symbolic link. Every preview would be written wherever the link '
      + 'points, which is not the directory you named, so it is refused. Name the real directory.',
    )
  }
  if (existing !== null && !existing.isDirectory()) {
    throw new DestinationError('--preview-dir exists and is not a directory.')
  }
  if (existing === null) await mkdir(target, { recursive: true })
  return realpath(target)
}

/**
 * Create the directories a preview needs without ever following a link.
 *
 * `mkdir(path, {recursive: true})` walks straight through a symlinked
 * component, so a link planted inside the preview directory creates real
 * directories outside it before any check has run -- the write is refused
 * afterwards and those directories stay. Each component is inspected with
 * `lstat` instead, and created only inside a directory already known to be a
 * real one.
 */
async function makeDirectoryWithin(base, directory) {
  const inside = relative(base, directory)
  if (inside === '..' || inside.startsWith(`..${sep}`) || inside.startsWith(sep)) {
    throw new DestinationError(
      `--preview-dir would place a preview at ${directory}, which is outside ${base}. `
      + 'An input above the reporting root does not widen where previews are written.',
    )
  }
  let current = base
  for (const part of inside.split(sep)) {
    if (part === '') continue
    current = join(current, part)
    let existing = null
    try {
      existing = await lstat(current)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new DestinationError(`${current} could not be inspected: ${error.code ?? 'unknown error'}`)
      }
    }
    if (existing === null) {
      await mkdir(current)
      continue
    }
    if (existing.isSymbolicLink()) {
      throw new DestinationError(`${current} is a symbolic link; a preview is never written through one.`)
    }
    if (!existing.isDirectory()) {
      throw new DestinationError(`${current} exists and is not a directory.`)
    }
  }
}

/**
 * Write the previews, after proving each destination is a file this tool may
 * create or replace. The guard runs before the directory is created and before
 * anything is opened, because both of those acts follow a link.
 */
async function writePreviews(previews, documents, previewDir) {
  const base = await openPreviewRoot(previewDir)
  const inputs = documents.map((document) => document.absolute)
  for (const preview of previews) {
    const destination = resolve(base, preview.file)
    await makeDirectoryWithin(base, dirname(destination))
    const target = await assertWritableDestination(destination, { inputs, root: base, label: '--preview-dir' })
    await writeFile(target, preview.text, 'utf8')
    process.stderr.write(`preview written: ${target}\n`)
  }
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  try {
    const config = options.config === null ? undefined : await loadConfig(options.config)
    const { documents, failures } = await readDocuments(options.files, {
      root: options.root ?? undefined,
      limits: config?.limits,
    })
    const { report, previews } = validateDocuments(documents, { config, failures, clock })

    if (options.previewDir !== null) await writePreviews(previews, documents, options.previewDir)

    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
    if (report.status === 'incomplete') return 2
    return report.status === 'fail' ? 1 : 0
  } catch (error) {
    const detail = error instanceof LimitExceeded ? `limit exceeded: ${error.message}` : error.message
    process.stderr.write(`${detail}\n`)
    return 2
  }
}

process.exitCode = await main(process.argv.slice(2))
