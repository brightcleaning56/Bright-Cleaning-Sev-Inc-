# Verifying BUILDINTEL without internet access

`buildintel-offline.tar.gz` contains the source **and** its runtime dependencies (`node_modules`, installed from
`package-lock.json` with `npm ci --omit=dev --omit=optional`; the optional native canvas add-on is not needed —
BUILDINTEL only reads PDF text on the server). Nothing needs downloading for the automated tests.

    tar xzf buildintel-offline.tar.gz && cd buildintel
    node scripts/doctor.mjs                      # Node 22.13+, pg and pdfjs-dist present at the pinned versions
    node --test test/*.test.js                   # all tests that need no database (4 PostgreSQL tests skip)
    TEST_DATABASE_URL=postgres://user:pass@localhost/db node scripts/test-ci.mjs   # everything, no skips allowed

Browser QA (`bash qa/run.sh`) additionally needs Python Playwright and Chromium (`pip install -r qa/requirements.txt
&& playwright install chromium`), which require a download. The last full run's browser logs and screenshots are in
`release-evidence/` — check them with `cd release-evidence && sha256sum -c MANIFEST.sha256`.
