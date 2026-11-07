#!/usr/bin/env bash
# Onboards Bright Clean as tenant #1. Fill in the variables, then run:
#   BASE=https://app.yourdomain.com EMAIL=you@x.com PASSWORD='...' ./scripts/onboard-bright-clean.sh
set -euo pipefail
: "${BASE:?}" "${EMAIL:?}" "${PASSWORD:?}"
LEGAL_NAME="${LEGAL_NAME:?Bright Clean legal name}"
POSTAL="${POSTAL:?Bright Clean postal address — required on every bid email}"
SENDER="${SENDER:?sending address on your verified domain, e.g. bids@brightclean.com}"
PHONE="${PHONE:-}"

j() { node -e "process.stdout.write(JSON.stringify($1))"; }
TOKEN=$(curl -sf -XPOST "$BASE/api/login" -H 'content-type: application/json' \
  -d "$(j "{email:'$EMAIL',password:process.env.PASSWORD}")" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
H=(-H "authorization: Bearer $TOKEN" -H 'content-type: application/json')

curl -sf -XPATCH "$BASE/api/org" "${H[@]}" -d "$(LEGAL_NAME="$LEGAL_NAME" POSTAL="$POSTAL" SENDER="$SENDER" PHONE="$PHONE" node -e '
  const e=process.env; process.stdout.write(JSON.stringify({legal:{name:e.LEGAL_NAME,postalAddress:e.POSTAL,phone:e.PHONE},senderEmail:e.SENDER,
  settings:{coverage:["des moines, ia","west des moines, ia","ankeny, ia","dallas, tx"],minContract:1500}}))')" > /dev/null
echo "✓ legal identity saved"

node -e 'JSON.parse(require("fs").readFileSync("scripts/bright-clean-rates.json")).forEach(r=>{delete r._instructions;console.log(JSON.stringify(r))})' |
while read -r card; do
  out=$(curl -s -XPOST "$BASE/api/rate-cards" "${H[@]}" -d "$card")
  echo "$out" | grep -q '"error"' && { echo "✗ rate card rejected: $out"; exit 1; }
  echo "✓ rate card drafted (approve it in the dashboard → Pricing)"
done

curl -sf -XPOST "$BASE/api/org/activate" "${H[@]}" > /dev/null && echo "✓ Bright Clean active (dry-run)"
