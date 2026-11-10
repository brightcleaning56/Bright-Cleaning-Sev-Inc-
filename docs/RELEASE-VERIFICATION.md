# Release verification

Result: **PASS — release verified**

- Verified at: 2026-11-10T14:16:26Z
- App version: 1.9.0 · lockfile sha256: 6358df2d1b722a3d
- Git commit: 638f9e6
- Source sha256: 15f82792c28c97e1a7b237d96a40341ca47cc15b7612b67d75d550e944f72348 (recompute on your copy with `bash scripts/source-hash.sh`)
- Node v22.23.4 · PostgreSQL: PostgreSQL 16.15
- Tests: test-ci: PASSED (tests 248, passed 248, failed 0, skipped 0, cancelled 0)
- Browser QA checks passed: off 18/18, on 18/18

| Step | Result | Time |
|---|---|---|
| Clean install (npm ci, lockfile) | PASS | 3s |
| Environment (Node, dependencies, PostgreSQL) | PASS | 0s |
| All automated tests (no failures, no skips) | PASS | 21s |
| Dependency security audit | PASS | 0s |
| Browser QA, CORE_READS=off | PASS | 483s |
| Browser QA, CORE_READS=on | PASS | 482s |

Logs: `/tmp/tmp.zETtk0KGQd/logs` (kept on the machine that ran this).
- Evidence: `release-evidence/` (33 files; verify with `cd release-evidence && sha256sum -c MANIFEST.sha256`)
