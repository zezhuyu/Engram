import { runSuite, summarize } from './lib/suite.js';
summarize(await runSuite({
  name: 'unix', title: 'Unix text interoperability: cat head tail grep cut sort uniq wc tr paste comm diff find tree tee + filter bridge',
  files: ['dist/tests/unix/parity.test.js', 'dist/tests/unix/features.test.js', 'dist/tests/unix/sandbox.test.js'],
  // The macOS run records these exact external-tool prerequisites as skips; the same assertions pass in the Linux GNU lane.
  allowedSkips: ['awk: gawk --sandbox', 'sed: GNU sed --sandbox'],
  gaps: [
    { item: 'External-merge sort / spill', status: 'UNSUPPORTED', reason: 'sort, diff and comm checks hold at most MDB_UNIX_MAX_BUFFER_LINES lines and fail with an error instead of spilling.' },
    { item: 'Locales and byte-exact non-UTF-8 data', status: 'UNSUPPORTED', reason: 'Text tools assume UTF-8 and C-locale (byte/code point) ordering; invalid UTF-8 is replaced when a tool decodes lines (cat and tee copy bytes unchanged).' },
    { item: 'tail -f, grep -r, sort -o, diff -c, find -exec', status: 'UNSUPPORTED', reason: 'Refused on purpose: no following, no recursion on the local file system, no output files other than tee, no command execution.' }
  ],
  limitations: ['The macOS run classifies only the gawk/GNU sed dependent cases as expected skips; `MDB_REQUIRE_GNU=1 npm run verify:unix` passed 17/17 tests in Linux with gawk and GNU sed (verification/unix/gnu-report.json).', 'Where BSD and GNU differ the documented subset follows GNU semantics and the test normalizes or excludes the BSD quirk (see tests/unix/parity.test.ts).', 'find/tree operate on a virtual tree built from the vault metadata, not on files on disk.']
}));
