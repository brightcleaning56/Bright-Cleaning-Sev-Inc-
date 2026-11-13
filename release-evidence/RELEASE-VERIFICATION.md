# Release verification

Result: **PASS — release verified**

- Verified at: 2026-11-13T04:23:47Z
- App version: 1.9.0 · lockfile sha256: 6358df2d1b722a3d
- Git commit: ea42096
- Source sha256: d5c5d8bb3d5507218a938b2fe9c2b70015dfb9a7979f4d0a2fbff4a129f0ce43 (recompute on your copy with `bash scripts/source-hash.sh`)
- Node v22.23.4 · PostgreSQL: PostgreSQL 16.15
- Tests: test-ci: PASSED (tests 265, passed 265, failed 0, skipped 0, cancelled 0)
- Browser QA checks passed: off 19/19, on 19/19

| Step | Result | Time |
|---|---|---|
| Clean install (npm ci, lockfile) | PASS | 4s |
| Environment (Node, dependencies, PostgreSQL) | PASS | 0s |
| All automated tests (no failures, no skips) | PASS | 58s |
| Dependency security audit | PASS | 0s |
| Browser QA, CORE_READS=off | PASS | 500s |
| Browser QA, CORE_READS=on | PASS | 495s |

Logs: `/tmp/tmp.ZI5zTE4DoS/logs` (kept on the machine that ran this).
- Evidence: `release-evidence/` (33 files; verify with `cd release-evidence && sha256sum -c MANIFEST.sha256`)
