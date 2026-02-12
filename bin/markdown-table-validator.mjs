#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  LimitExceeded,
  formatReport,
  parseConfig,
  readDocuments,
  validateDocuments,
} from '../src/index.mjs'

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
never depends on filesystem enumeration order. The preview is a derived copy: an
input file is never rewritten, and a table that cannot be reformatted without
risking its content is copied through untouched and reported.

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

async function loadConfig(path) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(resolve(path), 'utf8'))
  } catch (error) {
    throw new Error(`Could not read configuration: ${error.message}`)
  }
  return parseConfig(parsed)
}

async function writePreviews(previews, documents, previewDir, root) {
  const byFile = new Map(documents.map((document) => [document.file, document.absolute]))
  const target = resolve(previewDir)
  for (const preview of previews) {
    const destination = resolve(target, preview.file)
    if (destination === byFile.get(preview.file)) {
      throw new Error(`Refusing to overwrite the input file ${preview.file}; choose a --preview-dir outside ${root}`)
    }
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, preview.text, 'utf8')
    process.stderr.write(`preview written: ${destination}\n`)
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
    const { root, documents, failures } = await readDocuments(options.files, {
      root: options.root ?? undefined,
      limits: config?.limits,
    })
    const { report, previews } = validateDocuments(documents, { config, failures, clock })

    if (options.previewDir !== null) await writePreviews(previews, documents, options.previewDir, root)

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
