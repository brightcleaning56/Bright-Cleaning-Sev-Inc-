# Deploy BUILDINTEL: console on Netlify, API on Render

Architecture: the owner console is static files published on Netlify. The API and its data run on
Render, which provides a persistent disk. Netlify has no persistent disk and runs only short functions, so the
API cannot run there as it is.

Two dashboards, one per host:
- **Netlify** (`netlify.toml`): serves `public/` with a strict Content-Security-Policy. Its only config value is the API address.
- **Render** (`Dockerfile`, `render.yaml`): runs `src/index.js` with the data file on a 1 GB disk at `/var/data`.

## Order of steps

### 1. Render: create the API service
1. Render → **New** → **Blueprint** → connect `brightcleaning56/Bright-Cleaning-Sev-Inc-`, branch
   `claude/buildintel-launch-requirements-i9bmnu`. Render reads `render.yaml`.
2. Render generates `BUILDINTEL_ADMIN_KEY` and `BUILDINTEL_UNSUBSCRIBE_SECRET`. Copy the admin key from the
   service's **Environment** tab; you need it to sign in to the console.
3. Note the service URL, for example `https://buildintel-api.onrender.com`.
4. Set `BUILDINTEL_PUBLIC_URL` to that URL. Leave `BUILDINTEL_CORS_ORIGINS` empty until step 3 below.

### 2. Netlify: create the console site
1. Netlify → **Add new site** → **Import an existing project** → the same repo and branch.
2. Netlify reads `netlify.toml`: build command `node scripts/netlify-build.js`, publish directory `public`.
3. Under **Environment variables**, add `BUILDINTEL_API_URL` = the Render URL from step 1.3 (https, no path).
4. Deploy. The build fails if that value is missing or not https.
5. Note the site URL, for example `https://buildintel.netlify.app`.

### 3. Connect the two
1. Render → `buildintel-api` → **Environment** → set `BUILDINTEL_CORS_ORIGINS` to the Netlify URL from step 2.5. Redeploy.
2. Open the Netlify URL. Sign in with the admin key from step 1.2.

## Safety settings that ship on
- `BUILDINTEL_SEND_MODE=dry_run`: no bid is sent. Live mode refuses to start until a provider adapter exists.
- `BUILDINTEL_AUTOPILOT=off`: turn it on from the console only after the Bright Clean tenant is set up.
- `BUILDINTEL_ALLOW_SAMPLE=0`: no demo permits in production.
- The readiness gates on the dashboard show what is still missing. Launch remains NO-GO until the owner inputs are real.

## Data and backups
- Data lives in `/var/data/state.json` on the Render disk. Deleting the disk deletes the data.
- Back up the file regularly. Restore test: copy it, start a second service with `BUILDINTEL_DATA_FILE` pointing at the copy,
  then check `GET /api/bids` with the admin key. Record the date in `data/readiness.json` as `backupRestoreTestedAt`
  only after you have actually done it.

## Verification status
- The build script refuses an empty or non-https API URL. Tested.
- The API and console work across two origins in a real browser, with CORS and the CSP enforced. Tested locally.
- The Dockerfile and `render.yaml` have **not** been built or deployed from this environment. Docker is not
  available here, and neither Netlify nor Render is connected to this session. Expect to fix small issues on the
  first deploy and check the Render build log.
- Render's disk is root-owned by default. The image runs as root for that reason. Tighten this once you confirm the
  disk permissions.
