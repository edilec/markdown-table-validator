# markdown-table-validator

Validate Markdown tables for shape, escaping, alignment and predictable
rendering.

- **Repository:** [edilec/markdown-table-validator](https://github.com/edilec/markdown-table-validator)
- **Area:** Docs & Knowledge
- **License:** MIT

## The problem

A Markdown table breaks quietly. A row with one cell too many silently loses a
value in GFM; a row with one too few silently gains an empty one. A pipe typed
inside a code span splits the row even though it looks like content. A delimiter
row with one wrong character turns the whole block back into a paragraph. None
of this is reported by the renderer, and a reviewer reading the diff sees pipes
that line up.

This tool reads the table the way GFM reads it, and names the exact line and
column that has to change.

## Install

Node 22 or newer. No runtime dependencies and no build step.

```sh
npm install github:edilec/markdown-table-validator
```

This installs the public GitHub source; `markdown-table-validator` is not published to npm.

Or run it from a checkout:

```sh
node bin/markdown-table-validator.mjs --help
```

## Commands

```sh
# check one or more documents
npx markdown-table-validator docs/api.md docs/cli.md

# apply content constraints from a policy file
npx markdown-table-validator --config examples/table-policy.json examples/clean.md

# machine-readable report, stdout carries nothing else
npx markdown-table-validator --json --config examples/table-policy.json docs/api.md

# write the derived formatting preview into a directory of its own
npx markdown-table-validator --preview-dir build/preview docs/api.md
```

| Option | Meaning |
| :---------------- | :-------------------------------------------------- |
| `--config FILE` | Content constraint configuration (JSON) |
| `--root DIR` | Report paths relative to this directory (default: cwd) |
| `--preview-dir DIR` | Write the derived preview of each input here |
| `--json` | Emit the machine-readable report on stdout |
| `-h`, `--help` | Show the help |

Repository scripts: `npm run lint`, `npm test`, `npm run test:coverage`,
`npm run example`, `npm run pack:check`, and `npm run check` for all of them.
The deliberately broken document is checked with:

```sh
node bin/markdown-table-validator.mjs --config examples/table-policy.json examples/broken.md
```

## Inputs

- **Markdown files**, named explicitly on the command line. No directory is ever
  walked, so nothing in the report depends on filesystem enumeration order. A
  relative input path is resolved against the working directory; `--root`
  changes only the paths written into the report, never which file is read.
- **A configuration file** (optional). It declares `limits`, `requiredColumns`
  and per-column constraints: `required`, `allowedValues`, `pattern`,
  `maxLength`, `unique` and `alignment`. Columns are matched by their exact
  header text. Anything the schema does not recognise is a usage error, never a
  silently ignored key. See [docs/table-rules.md](./docs/table-rules.md).

## Outputs

`--json` writes the report to stdout, and only the report, so it can be piped
straight into a parser. Diagnostics always go to stderr.

```json
{
  "schemaVersion": "1",
  "tool": "markdown-table-validator",
  "status": "fail",
  "summary": { "checked": 4, "errors": 9, "warnings": 4, "info": 2, "files": 1, "filesRead": 1, "tables": 4, "rows": 9 },
  "findings": [
    {
      "ruleId": "column-count-mismatch",
      "severity": "error",
      "message": "This row has 4 cell(s) but the table declares 3. GFM drops the 1 extra cell(s).",
      "location": { "file": "examples/broken.md", "pointer": "/tables/0/rows/1" },
      "line": 8,
      "column": 1,
      "evidence": "| Tsv Reader | beta   | Extra cell | oops |",
      "suggestion": "Write exactly 3 cell(s) on this line."
    }
  ]
}
```

Without `--json` the same findings are printed as `file:line:column severity
ruleId message`, followed by a one-line summary.

The **formatting preview** written by `--preview-dir` is a derived artifact. The
input file is never rewritten. Only padding changes: every cell's raw text is
copied through byte for byte, so `\|` and a code span survive exactly as
written. Before a table is reformatted the result is parsed again and every
cell, row and alignment must come back identical; a table that fails that check
is copied through untouched and reported as `preview-unavailable`.

### Where a preview may be written

Every preview lands under the real `--preview-dir`, and the destination is
checked before any directory is created and before anything is opened. Three
separate things are refused, because no one check catches the others:

| Refused | Why |
| :--- | :--- |
| A symbolic link at the destination | Writing through it puts the preview wherever the link points, which is not the path you named. It is refused on sight, never resolved. |
| A symbolic link on the way to it, `--preview-dir` itself included | A link leaving the directory takes the preview with it. The parent is resolved and compared, and each directory is created only inside a real one. |
| A destination that is the same file as an input | A hard link shares no path with the input and has no target to resolve, so only the device and inode show that it is one file. This tool never rewrites what it reads. |

A refused destination is a configuration error: exit `2`, empty stdout, nothing
written, and the reason on stderr. A preview directory that merely sits under a
symlinked ancestor -- a system temporary directory, typically -- is fine.

## Exit codes

| Code | Meaning |
| ---: | :------------------------------------------------------------ |
| `0` | Every table satisfied the checks |
| `1` | A table failed the checks (at least one `error` finding) |
| `2` | Invalid usage or configuration, or an input that could not be read in full |

An input that could not be read, decoded or parsed within its limits is reported
with status `incomplete` and exit `2`. It is never a pass.

## Limits and non-goals

This tool **cannot** conclude:

- **that a table renders correctly everywhere.** It models GFM. Other Markdown
  flavours differ, most visibly around pipes in code spans and the optional
  outer pipes.
- **that the content of a table is true, current or complete.** It checks shape
  and declared constraints. It knows nothing about what a cell means.
- **that a link, a reference or an identifier in a cell resolves.** Nothing is
  ever fetched; there is no network access of any kind.
- **that a table is well designed.** Column order, heading wording and whether
  the data belongs in a table at all are outside its scope.
- **that a block it skipped was not meant to be a table.** A header-looking line
  followed by something that is not close enough to a delimiter row is left
  alone, by design: guessing harder would flag ordinary prose that contains a
  pipe.
- **that padding will look aligned in your editor.** Column width is counted in
  code points, so wide glyphs, combining marks and emoji will not line up
  visually even though their content is preserved exactly.
- **that a configured `pattern` is safe.** Patterns come from your own
  configuration and are trusted input; a pathological one can still be slow.

It also does not fix anything. The preview is a separate file you can read,
diff and copy from; nothing is written back over your documents.

## License

MIT. See [LICENSE](./LICENSE).
