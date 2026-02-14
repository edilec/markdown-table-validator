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

- an input whose bytes are not UTF-8 is now always reported as `input-not-utf8`
  with status `incomplete` and exit `2`. Decoding is strict instead of inferred
  from the decoded text, so a file that carries undecodable bytes *and* a
  literal U+FFFD is no longer reported as a pass, and a file that legitimately
  contains U+FFFD is still checked normally.
- the command line now injects a clock, so the documented `timeLimitMs` budget
  is actually enforced there instead of being accepted and ignored. Exceeding it
  reports `limit-exceeded` with status `incomplete` and exit `2`.
- `--root` now does only what it is documented to do. It sets the directory
  reported paths are relative to; input paths are resolved against the working
  directory, so naming a root no longer turns a readable file into
  `input-unreadable`. `readDocuments` takes the two directories separately as
  `cwd` (resolution) and `root` (reporting).

No release has been published.
