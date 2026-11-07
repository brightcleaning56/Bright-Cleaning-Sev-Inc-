# Release verification

Result: **PASS — release verified**

- Verified at: 2026-11-05T09:29:09Z
- App version: 1.9.0 · lockfile sha256: 6358df2d1b722a3d
- Git commit: not a git checkout (zip)
- Source sha256: 726d9f3f9df509b42bca70aabf400b46f418952e96ecb066ddfc48a218c6097a (recompute on your copy with `bash scripts/source-hash.sh`)
- Node v22.22.2 · PostgreSQL: PostgreSQL 16.15
- Tests: test-ci: PASSED (tests 174, passed 174, failed 0, skipped 0, cancelled 0)
- Browser QA checks passed: off 12/12, on 12/12

| Step | Result | Time |
|---|---|---|
| Clean install (npm ci, lockfile) | PASS | 2s |
| Environment (Node, dependencies, PostgreSQL) | PASS | 0s |
| All automated tests (no failures, no skips) | PASS | 46s |
| Dependency security audit | PASS | 0s |
| Browser QA, CORE_READS=off | PASS | 351s |
| Browser QA, CORE_READS=on | PASS | 350s |

Logs: `/tmp/tmp.ICobtbHuRw/logs` (kept on the machine that ran this).
- Evidence: `release-evidence/` (33 files; verify with `cd release-evidence && sha256sum -c MANIFEST.sha256`)
