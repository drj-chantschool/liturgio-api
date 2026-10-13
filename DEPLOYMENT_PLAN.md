# Hosting & Deployment Plan

**Done (2026-10-12):** `liturgio-api` runs on DO App Platform from the `prod`
branch against a read-only copy of `liturgio` in DO Managed MySQL. Page images
are served from Spaces, the DB firewall is scoped to the app plus the admin IP,
and DO's daily backups are confirmed running. Details are in the 2026-10-12
entry of `../maintenance.md`.

## Current setup (reference)

| Piece | Where |
|---|---|
| App | App Platform `liturgio-app` (`016ee61d-…`), deploys on push to `prod` |
| DB | Managed MySQL 8.4 `db-mysql-nyc3-73323`, schema `liturgio`; app connects as `liturgio_ro` |
| Images | Spaces `liturgio-images` (sfo3), key `books/<book>/<printed_page_num>.png`; app holds a **read-only** key (`liturgio-api-ro`) |
| Secrets | App env vars `LITURGIO_DB_PASSWORD` and `LITURGIO_SPACES_SECRET` are type `SECRET`; local copies are in the keyring (`liturgio-mysql-do`, `liturgio-images`, `liturgio-images-ro`) |
| Firewall | Trusted Sources: the app, plus admin IP `47.188.36.253` |

Local MySQL is the master and DO is a copy. The prod app is read-only: every
non-GET request returns 403.

**Refreshing DO from local** (manual, as needed):
1. `mysqldump` local `liturgio` with `--single-transaction --routines
   --set-gtid-purged=OFF --no-tablespaces --column-statistics=0`, ignoring
   `books` and any `*_bak_*` tables, and strip `DEFINER=` clauses.
2. Import as `doadmin`, prefixed with
   `SET SESSION restrict_fk_on_non_standard_key=OFF;` (needed because
   `service_part.subservice_part_fk` references a non-unique key, which
   MySQL 8.4 rejects by default).
3. Recreate `books` on DO from the local DDL **minus `image_blob`** and
   copy the other columns.
4. If new book pages were added, run `scripts/upload_book_images_to_spaces.py`
   (idempotent, skips existing objects).
5. Compare row counts for every table, local vs DO.

## Todos

- [ ] **Smoke-test the live app URL** once the first deployment finishes.
      Run the same endpoint sweep that already passed against DO from a
      local instance in prod mode.
- [ ] **Decide on App Platform sizing.** The spec runs 2 × `apps-s-1vcpu-1gb`
      (~$24/mo); the original budget assumed one $5 Basic instance.
- [ ] **Script the refresh above** (`scripts/sync_to_do.py`) so it isn't a
      hand-run sequence.
- [ ] **Keep the admin IP in Trusted Sources current.** It's a residential IP;
      if it changes, local admin access and the `liturgio-do` MCP server lose
      access until the rule is updated.
- [ ] **Scheduled `mysqldump` to Spaces** with our own retention (e.g. 30
      daily dumps), as a portable backup beyond DO's fixed 7-day window.
- [ ] **Decide whether local `books.image_blob` stays.** It's 464MB and is
      still the local proofreading cache (and the source for uploads); DO
      never receives it.

## Future — write path (review queue), not started

- [ ] Review-queue table(s) in the same database, isolated by MySQL grants.
      The public app keeps only the RO credential plus INSERT on the queue,
      and never writes the real tables.
- [ ] A separate full-privilege user for a periodic **manual**
      pull-and-apply sync, held only on the admin machine, Trusted Sources
      limited to the admin IP/VPC; optionally rotate its password after each
      sync.
- [ ] Lift the prod read-only guard (`_read_only_guard` / `rw()` in `app.py`)
      only for the queue endpoints.
