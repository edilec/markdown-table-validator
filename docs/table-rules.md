# Table rules, limits and determinism

This document is the reference for what `markdown-table-validator` checks, what
it refuses to guess, and what it guarantees about its own output.

## How a row is read

The reader follows GFM, and says so explicitly because the hard cases are
exactly where flavours disagree.

1. **A row is split at every pipe that is not escaped.** A backslash escapes the
   character after it, so `\|` never splits a row. This happens before any
   inline parsing.
2. **`\|` becomes a literal pipe in the cell's content**, including inside a
   code span, because the unescaping happens while the row is being split. The
   cell's *raw* text keeps the backslash; the cell's *content* has the pipe.
3. **A raw pipe inside a code span still splits the row.** GFM splits first and
   parses inline spans afterwards, so `` `a|b` `` becomes two cells. Code spans
   are located separately (a run of N backticks closes at the next run of
   exactly N backticks, and a backslash stops a run from opening one) so this
   can be reported as `pipe-in-code-span` at the exact pipe instead of appearing
   as a confusing column count.
4. **The outer pipes are optional**, and a leading or trailing pipe is removed
   before cells are counted.
5. **Cells are trimmed.** Leading and trailing whitespace is not content.
6. **A delimiter cell** is dashes with optional colons: `---`, `:---`, `---:` or
   `:---:`. A leading colon means left, a trailing colon means right, both mean
   centre, neither means none.
7. **A table ends** at a blank line, a fenced code block, a thematic break, an
   ATX heading or a blockquote marker.
8. **Fenced code blocks are skipped entirely**, so an example table inside one
   is never checked.

A block is treated as an attempted table when the line after a line containing a
pipe is a delimiter row, or is *nearly* one: it has pipes and at least half of
its cells are real delimiter cells. That threshold is deliberate. Guessing
harder would flag ordinary prose containing a pipe and a dash; guessing less
would pass over the single most common table typo in silence.

## Rule catalog

Rule ids are stable. Renaming one is a breaking change and is recorded in the
changelog.

| ruleId | Severity | What it means |
| :------------------------------- | :------ | :---------------------------------- |
| `delimiter-row-invalid` | error | A cell of the delimiter row is not dashes with optional colons, so the block does not render as a table |
| `header-delimiter-count-mismatch` | error | The delimiter row declares a different number of columns than the header, so the block does not render as a table |
| `column-count-mismatch` | error | A row has more or fewer cells than the table declares; the message says whether GFM drops cells or appends empty ones |
| `pipe-in-code-span` | error | An unescaped pipe inside a code span, which still splits the row |
| `column-missing` | error | A table does not contain a configured `requiredColumns` heading |
| `cell-required-empty` | error | A column configured `required` has an empty cell |
| `cell-value-not-allowed` | error | A cell is outside the configured `allowedValues` |
| `cell-pattern-mismatch` | error | A cell does not match the configured `pattern` |
| `header-cell-empty` | warning | A column has no heading |
| `header-cell-duplicate` | warning | Two columns share a heading |
| `pipe-style-inconsistent` | warning | A row does not use the same outer pipes as the header row |
| `table-has-no-data-rows` | warning | A header and delimiter row with nothing under them |
| `cell-value-duplicate` | warning | A column configured `unique` repeats a value |
| `cell-too-long` | warning | A cell is longer than the configured `maxLength`, counted in code points |
| `column-alignment-unexpected` | warning | The delimiter row declares an alignment the configuration does not expect |
| `preview-unavailable` | info | The formatting preview left a table unchanged, with the reason |
| `input-unreadable` | error | A named input could not be read |
| `input-not-text` | error | An input contains NUL bytes |
| `input-not-utf8` | error | An input is not valid UTF-8, so its content could not be read exactly |
| `limit-exceeded` | error | A declared limit was reached; the file was not fully checked |

Only `error` findings fail a run. The four input rules also make the run
`incomplete`, which exits `2` whatever else was found.

Decoding is strict. Input bytes go through a fatal UTF-8 decoder, so bytes that
cannot be decoded are always `input-not-utf8`, and a document that legitimately
contains U+FFFD is checked like any other document.

Content constraints apply to a cell's **content**: trimmed, with `\|`
unescaped. `required` governs emptiness; `allowedValues`, `pattern`, `maxLength`
and `unique` are only applied to cells that are not empty, so an empty cell
produces one finding rather than four.

## Configuration

```json
{
  "schemaVersion": "1",
  "requiredColumns": ["Name", "Status"],
  "limits": { "maxRowsPerTable": 2000 },
  "columns": {
    "Name": { "required": true, "unique": true, "pattern": "^[A-Z][A-Za-z0-9 ]*$" },
    "Status": { "required": true, "allowedValues": ["stable", "beta"], "alignment": "center" },
    "Notes": { "maxLength": 60 }
  }
}
```

`schemaVersion` must be `"1"`. Columns are matched by exact header text.
`alignment` is one of `none`, `left`, `right`, `center`. `pattern` is a
JavaScript regular expression compiled with the `u` flag, at most 200
characters. `requiredColumns` applies to every table in the checked inputs.
Any unknown key, wrong type or invalid pattern is a usage error and exits `2`.

## Limits

Every limit is explicit, and exceeding one produces a `limit-exceeded` finding
with status `incomplete` and exit `2`. A limit is never a silent truncation and
never a pass.

| Limit | Default | Applies to |
| :------------------ | --------: | :------------------------------------- |
| `maxFiles` | 500 | Inputs named in one run |
| `maxBytes` | 2000000 | Bytes of a single file |
| `maxLines` | 50000 | Lines of a single file |
| `maxLineLength` | 10000 | Characters of a single line |
| `maxTables` | 500 | Tables in a single file |
| `maxRowsPerTable` | 5000 | Data rows of a single table |
| `maxColumns` | 200 | Columns of a single table |
| `timeLimitMs` | 10000 | Elapsed-time budget for parsing one file |

The reader is line-based and has no recursive descent, so there is no recursion
depth to bound: the deepest nesting it tracks is a fenced code block, which is a
single flag. `timeLimitMs` is measured with a clock the caller injects
(`validateDocuments(documents, { clock })`), so the library reads no clock of
its own; the command line injects the process monotonic clock
(`performance.now`). The budget can only ever turn a run into an explicit
`limit-exceeded` with status `incomplete`, never change a finding.

## The formatting preview

The preview is a **derived artifact**. No input file is ever modified.

- Only padding changes. Each cell's raw text is copied through byte for byte, so
  `\|`, a code span and every other escape survive exactly as written.
- The delimiter row is rewritten to the same alignment it already declared.
- Before a table is accepted the rendered text is parsed again and every cell,
  row count and alignment must come back identical. A table that fails that
  check, or whose rows do not all have the declared number of cells, is copied
  through untouched and reported as `preview-unavailable`.
- Width is counted in code points, not rendered glyph width, so a column of wide
  glyphs or emoji will not look aligned even though its content is intact.
- Line endings in the preview are LF.

## Determinism

Running the tool twice over identical inputs produces byte-identical stdout.

- Findings sort by `location.file`, then `line`, then `column`, then `ruleId`,
  then `location.pointer`, then `message`. Strings are compared by UTF-16 code
  unit with a plain `(a < b ? -1 : a > b ? 1 : 0)` comparator. No locale-aware
  comparison is used anywhere, because ICU data differs between Node builds and
  would make the output machine-dependent.
- Documents are processed in the order they are named. No directory is ever
  walked, so filesystem enumeration order cannot reach the report.
- Reported paths are made relative to `--root` (default: the working directory)
  and always use `/` as the separator, so the same run reports the same paths on
  every platform. A relative input path is resolved against the working
  directory, so the reporting root can never change which file is read.
- No wall-clock time, random value or hash iteration order affects any output.
  The only clock is the injectable `timeLimitMs` budget described above, and it
  can only add a `limit-exceeded` finding; it never changes another finding.
- Nothing is fetched. There is no network access, telemetry or provider call.
- Evidence excerpts are bounded to 120 code points, and control characters,
  U+2028 and U+2029 are written as escape text, so one finding is always one
  line and an excerpt cannot be mistaken for a directive.
- A configuration that will not parse is reported by its offset — position, line
  and column — and never by the text it failed on. V8 reports a parse failure
  two ways and one of them quotes the input back, `Unexpected token 'A',
  "AKIAIOSFODNN7EXAMPLE" is not valid JSON`, which reproduces the first ten
  characters of the file, or the whole file when it is shorter than that. A
  configuration short enough to be nothing but a credential would otherwise be
  printed in full to stderr, on the one path an unparseable file is guaranteed
  to take. A failure to *read* the file is reported separately and still names
  the syscall.
