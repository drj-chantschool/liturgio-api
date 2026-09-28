# Hosting & Deployment Plan

Plan for moving `liturgio-api` and the `liturgio` MySQL database off local dev
and onto DigitalOcean, as a step toward releasing apps that use it as a data
backend.

## Decisions

- **Provider: DigitalOcean.** Managed MySQL + App Platform + Spaces beats the
  AWS RDS / Google Cloud SQL / PlanetScale alternatives on cost for our data
  size, without requiring a database-engine migration (stays MySQL,
  no rewrite of `app.py`'s SQLAlchemy/`mysql-connector-python` code).
- **Managed database, not a self-managed Droplet.** We're trading ~$3-8/mo
  for automated backups and no OS/DB patching burden.
- **No HA (high availability) yet.** HA = a live standby replica in another
  AZ that takes over automatically on failure, avoiding downtime. DO's HA
  tier costs ~2x the single-node price. At our current scale a few minutes
  of restore-from-backup downtime on failure is an acceptable tradeoff;
  this can be upgraded later via a plan resize with no migration.
- **Architecture stays API-mediated.** Apps talk to `liturgio-api` over
  HTTPS; no client ever holds a DB credential, direct or otherwise.
- **`books.image_blob` moves out of the database** and into DO Spaces.
  It's a 395MB internal proofreading/review artifact (dpi-200 page-image
  cache), not something a consumer app needs at runtime. This keeps the
  Managed Database's actual working set to the app-facing tables
  (`lit_epoch`, `lit_part_sources`, `chant_group`, `local_chants`,
  `gregobase_*`, `psalms`, `vulgclementine_verses`, ...) at roughly 50MB.

## Cost

| Component | Plan | Cost |
|---|---|---|
| Managed MySQL | Single-node, 1 vCPU / 1GB RAM / 10GB SSD, no HA | $15/mo |
| App Platform | Basic tier, hosts `liturgio-api` | $5/mo |
| Spaces | 250GB object storage, for `books.image_blob` | $5/mo |
| **Total** | | **$25/mo** |

## Credential & network security

Read-only path (live now):

- `liturgio_ro` gets its own prod password, distinct from the local dev
  keyring credential.
- DB firewall **Trusted Sources** scoped to the App Platform app only —
  the credential is useless outside that network path even if leaked.
- Password stored as an App Platform **encrypted `SECRET` env var**
  (never `GENERAL`, never committed to the repo).
- TLS enforced on the connection; verify the CA cert in the SQLAlchemy
  connection string rather than disabling verification.

Write path (future — review-queue design):

- Review-queue table(s) live in the **same database**, isolated by MySQL
  grants rather than a separate instance (simpler, no extra cost).
- The always-on public app only ever holds the RO credential and writes
  proposals to the review queue — never directly to the real tables.
- The full-privilege credential lives only on a secure local/admin
  machine and is used to run a periodic **manual** pull-and-apply sync —
  no standing service holds it.
- Trusted Sources for that full-privilege user is scoped to the specific
  admin IP or VPC, **not** the public App Platform app.
- Optional: rotate the full-privilege password after each manual sync
  session.

## Backups

- DO Managed MySQL includes **daily automated backups with 7-day
  point-in-time recovery**, bundled into the $15/mo tier at no extra
  cost. Restoring spins up a **new** cluster (not in-place), and there's
  no export/download of the backup file — it's internal to DO.
- This covers accidental data loss/corruption (bad write, botched sync,
  accidental delete). It does **not** mitigate credential-leak risk —
  that's handled separately by Trusted Sources + secret scoping above.
- Supplement with a scheduled `mysqldump` to the Spaces bucket, giving us
  a portable backup we actually hold, with our own retention policy
  (e.g., keep the last 30 daily dumps) independent of DO's fixed 7-day
  window.

## Todos

### Phase 1 — Provision infrastructure
- [ ] Create DO Managed MySQL cluster (single-node, no HA)
- [ ] Create DO Spaces bucket for page images
- [ ] Create DO App Platform app for `liturgio-api`

### Phase 2 — Shrink and move the data
- [ ] Migrate `books.image_blob` rows out to Spaces; replace the column
      with a reference/URL
- [ ] Update `liturgio-api` image-serving code
      (`GET /api/books/{book}/{pdf_page_num}/image`) to fetch from Spaces
- [ ] Dump current schema + data (excluding image blobs) and import into
      the new Managed MySQL cluster

### Phase 3 — Credentials & network security
- [ ] Create a `liturgio_ro` user on the managed cluster with its own
      prod password
- [ ] Configure the cluster's Trusted Sources firewall scoped to the App
      Platform app
- [ ] Store the `liturgio_ro` password as an App Platform encrypted
      `SECRET` env var
- [ ] Update `app.py`'s DB connection code: read from env vars in prod,
      keep keyring for local dev, verify TLS/CA cert on the connection
      string

### Phase 4 — Backups
- [ ] Verify DO's default daily backups + 7-day PITR are active on the
      new cluster
- [ ] Write a scheduled `mysqldump`-to-Spaces job with its own retention
      policy (e.g., 30 daily dumps)

### Phase 5 — Deploy & verify
- [ ] Deploy `liturgio-api` to App Platform, connect to the Managed DB,
      smoke-test all endpoints end-to-end

### Phase 6 — Write-schema (future, not started)
- [ ] Design review-queue table(s) in the same database, isolated via
      MySQL grants
- [ ] Create a separate full-privilege DB user for the manual sync
      workflow, Trusted Sources restricted to admin IP/VPC only, never
      exposed to the App Platform app
