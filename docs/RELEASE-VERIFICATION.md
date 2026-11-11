# Release verification

Result: **PASS — release verified**

- Verified at: 2026-11-11T01:08:44Z
- App version: 1.9.0 · lockfile sha256: 6358df2d1b722a3d
- Git commit: 3ef1374
- Source sha256: 6ba35555c349d22d54b07c5e49f82248b2043bfac4a2533ae631305baffbfd2f (recompute on your copy with `bash scripts/source-hash.sh`)
- Node v22.23.4 · PostgreSQL: PostgreSQL 16.15
- Tests: test-ci: PASSED (tests 252, passed 252, failed 0, skipped 0, cancelled 0)
- Browser QA checks passed: off 18/18, on 18/18

| Step | Result | Time |
|---|---|---|
| Clean install (npm ci, lockfile) | PASS | 1s |
| Environment (Node, dependencies, PostgreSQL) | PASS | 0s |
| All automated tests (no failures, no skips) | PASS | 19s |
| Dependency security audit | PASS | 1s |
| Browser QA, CORE_READS=off | PASS | 480s |
| Browser QA, CORE_READS=on | PASS | 480s |

Logs: `/tmp/tmp.oCF51zbXE1/logs` (kept on the machine that ran this).
- Evidence: `release-evidence/` (33 files; verify with `cd release-evidence && sha256sum -c MANIFEST.sha256`)
