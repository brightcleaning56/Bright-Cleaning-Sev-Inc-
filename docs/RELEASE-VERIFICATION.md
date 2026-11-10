# Release verification

Result: **PASS — release verified**

- Verified at: 2026-11-10T06:53:50Z
- App version: 1.9.0 · lockfile sha256: 6358df2d1b722a3d
- Git commit: 2c90e9e
- Source sha256: 91cc270f70fe1eac963f15b7474e112f5ed84d6514eae35987553387b8f94085 (recompute on your copy with `bash scripts/source-hash.sh`)
- Node v22.23.4 · PostgreSQL: PostgreSQL 16.15
- Tests: test-ci: PASSED (tests 230, passed 230, failed 0, skipped 0, cancelled 0)
- Browser QA checks passed: off 16/16, on 16/16

| Step | Result | Time |
|---|---|---|
| Clean install (npm ci, lockfile) | PASS | 1s |
| Environment (Node, dependencies, PostgreSQL) | PASS | 0s |
| All automated tests (no failures, no skips) | PASS | 19s |
| Dependency security audit | PASS | 0s |
| Browser QA, CORE_READS=off | PASS | 467s |
| Browser QA, CORE_READS=on | PASS | 468s |

Logs: `/tmp/tmp.8GLLaDYWpD/logs` (kept on the machine that ran this).
- Evidence: `release-evidence/` (33 files; verify with `cd release-evidence && sha256sum -c MANIFEST.sha256`)
