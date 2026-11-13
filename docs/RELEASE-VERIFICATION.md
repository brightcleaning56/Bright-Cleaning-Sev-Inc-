# Release verification

Result: **PASS — release verified**

- Verified at: 2026-11-13T04:50:50Z
- App version: 1.9.0 · lockfile sha256: 6358df2d1b722a3d
- Git commit: 1fa9956
- Source sha256: ef8ca4d74f909aa93f66f20926111ca89e3a3b88fb80a334beb3a1fc121a6b4c (recompute on your copy with `bash scripts/source-hash.sh`)
- Node v22.23.4 · PostgreSQL: PostgreSQL 16.15
- Tests: test-ci: PASSED (tests 265, passed 265, failed 0, skipped 0, cancelled 0)
- Browser QA checks passed: off 19/19, on 19/19

| Step | Result | Time |
|---|---|---|
| Clean install (npm ci, lockfile) | PASS | 1s |
| Environment (Node, dependencies, PostgreSQL) | PASS | 0s |
| All automated tests (no failures, no skips) | PASS | 55s |
| Dependency security audit | PASS | 0s |
| Browser QA, CORE_READS=off | PASS | 499s |
| Browser QA, CORE_READS=on | PASS | 496s |

Logs: `/tmp/tmp.Kyli3GTssP/logs` (kept on the machine that ran this).
- Evidence: `release-evidence/` (33 files; verify with `cd release-evidence && sha256sum -c MANIFEST.sha256`)
