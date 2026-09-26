# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a GFM table reader that records the exact 1-based line of every row and column
  of every cell, splits rows the way GFM does, keeps `\|` as content, and locates
  code spans so an unescaped pipe inside one is reported rather than swallowed;
- structural rules for column shape, invalid and mismatched delimiter rows,
  empty and duplicated headings, inconsistent outer pipes and empty tables;
- opt-in content constraints per column: `required`, `allowedValues`, `pattern`,
  `maxLength`, `unique` and an expected `alignment`, plus `requiredColumns`;
- a formatting preview that is a derived artifact only: it changes padding,
  copies every cell through byte for byte, proves the result round-trips before
  accepting it, and never rewrites an input file;
- explicit limits on files, bytes, lines, line length, tables, rows, columns and
  wall-clock time, each reported as `incomplete` rather than truncating;
- a CLI with `--config`, `--root`, `--preview-dir`, `--json` and exit codes
  0 / 1 / 2;
- a clean and a deliberately broken example with a runnable policy file;
- the rule catalog, configuration reference, limits and determinism guarantee in
  `docs/table-rules.md`.

### Fixed

- the `--config` diagnostic no longer republishes the configuration it could not
  parse. V8 reports a parse failure two ways, and one of them quotes the input
  back -- `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` --
  which reproduces the first ten characters of the file, or the whole file when
  it is shorter than that. The command line interpolated that message whole onto
  stderr, so a configuration short enough to be nothing but a credential was
  printed in full. `parseFailureDetail` in `src/index.mjs` now keeps the offset,
  line and column and drops the quoted half, and the read failure is caught
  separately so an ENOENT still names the syscall.
  `test/parse-failure.test.mjs` plants the canary through the real binary and
  asserts it is absent from stdout, from stderr and from every prefix of it down
  to eight characters, because V8 quotes only ten.
- an input whose bytes are not UTF-8 is now always reported as `input-not-utf8`
  with status `incomplete` and exit `2`. Decoding is strict instead of inferred
  from the decoded text, so a file that carries undecodable bytes *and* a
  literal U+FFFD is no longer reported as a pass, and a file that legitimately
  contains U+FFFD is still checked normally.
- the command line now injects a clock, so the documented `timeLimitMs` budget
  is actually enforced there instead of being accepted and ignored. Exceeding it
  reports `limit-exceeded` with status `incomplete` and exit `2`.
- `--preview-dir` no longer writes outside the directory it names, and no longer
  destroys what it was reading. Three separate holes were open at once, and the
  single string comparison that stood there closed none of them: a symbolic link
  at the destination was followed, so a preview overwrote a file outside the
  tree -- or created one, when the link pointed at a path that did not exist
  yet; a symlinked `--preview-dir`, or a symlinked directory inside it, took
  every preview with it, and `mkdir(..., {recursive: true})` created those
  directories outside the tree before anything was checked; and a hard link to
  an input shares no path with it, so the preview of a document was written back
  over the document itself. Both of the last two exited `1` with
  `preview written:` on stderr. `assertWritableDestination` in
  `src/write-guard.mjs` now refuses a link on sight with `lstat`, resolves the
  parent before comparing it with the real preview directory, and compares
  device and inode against every input. Each directory is created inside one
  already known to be real, so the check happens before anything is created.
  A refused destination is a configuration error: exit `2`, empty stdout.
  `test/write-guard.test.mjs` pins one case per hole and the destinations that
  must keep working, because a guard that refuses everything passes a data-loss
  test while making the option useless.
- `--root` now does only what it is documented to do. It sets the directory
  reported paths are relative to; input paths are resolved against the working
  directory, so naming a root no longer turns a readable file into
  `input-unreadable`. `readDocuments` takes the two directories separately as
  `cwd` (resolution) and `root` (reporting).

No release has been published.
