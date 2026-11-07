#!/usr/bin/env bash
# Fingerprint of the source tree (what was verified). Run from the project root on an unzipped release; the result must
# match "Source sha256" in docs/RELEASE-VERIFICATION.md. Excludes installed dependencies, generated evidence and data.
cd "$(dirname "$0")/.." && find . -type f ! -path './node_modules/*' ! -path './release-evidence/*' ! -path './test-results/*' ! -path './data/*' ! -path './.git/*' \
  ! -name 'RELEASE-VERIFICATION.md' ! -name '*.pyc' ! -path '*/__pycache__/*' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
