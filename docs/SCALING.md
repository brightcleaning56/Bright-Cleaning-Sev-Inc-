# Scaling BUILDINTEL

## Now (pilot through first paying subscribers)
PostgreSQL is the system of record (`DATABASE_URL`). The app keeps a working copy in memory and
writes every change to Postgres in one transaction per save. Failed writes are retried and surface
on `/health` and the "Production database" launch gate. Run **one** app instance.

**Measured limits** (worst case: every permit a separate project; heap measured after loading and linking, Node 22):

| Permits | App memory (heap) | Project linking at startup |
|---|---|---|
| 5,000 | 21 MB | 0.45 s |
| 10,000 | 40 MB | 0.78 s |
| 50,000 | 203 MB | 3.5 s |
| 100,000 | 405 MB | 7.4 s |

About **4.2 KB per permit**, growing linearly. Practical ceilings, leaving room for the runtime and requests:
**~80,000 permits on Render Starter (512 MB)**, **~350,000 on Standard (2 GB)**. Current live volume is ~1,500 job
sites. Plan-room text adds up to 500 KB per document (bounded). Re-measure with `scripts` from `docs/PROJECT-CORE.md`
when data grows, and check the instance's memory graph in Render.

Move from the pilot JSON file: `DATABASE_URL=... DATA_FILE=... node src/cli.js migrate-to-pg`
(prints record counts and a checksum comparison).

**Search in PostgreSQL (`SQL_READS=on`), 50,000 permits, median of 5:** default list 339 ms (memory 1,035 ms); text
search 75 ms (394 ms); value sort 345 ms (1,059 ms); page 40 357 ms (1,094 ms); type + minimum value 44 ms (232 ms).
Results identical to the memory path. Writing 50,000 permits to PostgreSQL (records + `bi_permits`): 8.4 s, one time.

## Next (when any of these is true)
More than one app instance, more than ~60,000 permits on Starter (~280,000 on Standard), or startup over ~15 seconds.
This is Project Intelligence Core phase 3 (`docs/PROJECT-CORE.md`): database-backed reads, versioned writes, change
notifications. Scheduled jobs already take a cross-server lock.
Change: make `Store` methods async and query Postgres directly (indexes on (collection, org_id)
already exist), add a jobs table with `SELECT … FOR UPDATE SKIP LOCKED` so several workers can run
cycles safely, and move proposals/contracts HTML to object storage. Domain modules call the store
through `get/list/tget/tlist/put/tput`, so the change is mechanical.

## SQL reporting today
Every record is a jsonb row: `SELECT data->>'status', count(*) FROM records WHERE collection='bids' AND org_id=$1 GROUP BY 1;`
