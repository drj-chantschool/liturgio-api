# Hosting & Deployment Plan

**Done (2026-10-12):** `liturgio-api` is live at
<https://liturgio-app-ychrf.ondigitalocean.app>, deployed from the `prod`
branch on DO App Platform. All endpoints were smoke-tested. It reads from a
read-only copy of `liturgio` in DO Managed MySQL. Page images
are served from Spaces, the DB firewall is scoped to the app plus the admin IP,
and DO's daily backups are confirmed running. Details are in the 2026-10-12
entry of `../maintenance.md`.

## Current setup (reference)

| Piece | Where |
|---|---|
| App | App Platform `liturgio-app` (`016ee61d-…`), deploys on push to `prod`; `gabc-tools` is pinned by commit in `requirements.txt`, so bump the pin when the library changes |
| DB | Managed MySQL 8.4 `db-mysql-nyc3-73323`, schema `liturgio`; app connects as `liturgio_ro` |
| Images | Spaces `liturgio-images` (sfo3), key `books/<book>/<printed_page_num>.png`; app holds a **read-only** key (`liturgio-api-ro`) |
| Secrets | App env vars `LITURGIO_DB_PASSWORD`, `LITURGIO_SPACES_SECRET`, `LITURGIO_SESSION_SECRET`, `LITURGIO_AUTH_DB_PASSWORD` (password-change DB user, see step 5 below) and `LITURGIO_QUEUE_DB_PASSWORD` (review-queue DB user, see "Review queue rollout") are type `SECRET`; local copies are in the keyring (`liturgio-mysql-do`, `liturgio-images`, `liturgio-images-ro`) |
| Firewall | Trusted Sources (cluster `b10e6c5d-…`): the app, plus admin IP `47.188.35.218` (was `47.188.36.253` until 2026-10-18) |

Local MySQL is the master and DO is a copy. The prod app is read-only: every
non-GET request returns 403.

**Schema first, then code.** Before pushing to `prod`, check whether any
commit since the last deploy reads a column or table that was added locally
after the last DO refresh (check the `../maintenance.md` entries dated after
it). If one does, bring DO up to date **first**, either by running the
migration script with `--do` (as `doadmin`) or by doing a full refresh
(below). Then push. Otherwise the new code queries a missing column, and
every affected endpoint returns 503 while the app itself still looks
healthy. On 2026-10-13 this took down `/api/day/*`: commit `f4e6268` read
`lit_part_sources.rank_code` before DO had it. Migration scripts should
take a `--do` flag (see `liturgio-tools/scripts/migrate_lh_office_2026_10_13.py`).

**Releasing (DB + code together): `scripts/sync_to_do.py`** (repo root).
With no flags it prints a read-only plan: the commits pending for `prod`, a
local-vs-DO schema diff, row-count differences and any new page images.
`--execute` then uploads any new images and imports local into
`liturgio_next` on DO. It verifies the row counts, then swaps the tables
into `liturgio` with one atomic `RENAME TABLE` (`app_user` and `edit_queue`
stay put).
Next it pushes `main:prod`, waits for that commit's deployment, and runs a
smoke test (`--smoke-user <name>` adds logged-in `/api/day` checks; the
password comes from keyring `liturgio-app`/`<name>`). The tables it
replaced stay in `liturgio_prev` until the next run, and `--rollback-db`
swaps them back. It refuses to run when columns or tables were dropped
locally, because the code still serving would break before the new code
deploys.

**Refreshing DO from local** (what the script automates; manual fallback):
1. `mysqldump` local `liturgio` with `--single-transaction --routines
   --set-gtid-purged=OFF --no-tablespaces --column-statistics=0`, ignoring
   `books`, `app_user`, `edit_queue` and any `*_bak_*` tables, and strip
   `DEFINER=` clauses. `app_user` is never synced: prod logins live only on DO
   (see below). Neither is `edit_queue`: it holds prod's pending edits and their
   history (see "Review queue rollout").
2. Import as `doadmin`, prefixed with
   `SET SESSION restrict_fk_on_non_standard_key=OFF;` (needed because
   `service_part.subservice_part_fk` references a non-unique key, which
   MySQL 8.4 rejects by default).
3. Recreate `books` on DO from the local DDL **minus `image_blob`** and
   copy the other columns.
4. If new book pages were added, run `scripts/upload_book_images_to_spaces.py`
   (idempotent, skips existing objects).
5. Compare row counts for every table, local vs DO (except `app_user` and
   `edit_queue`).

## Login rollout to prod (pending)

Do these in order. If the secret is missing, the new code refuses to start,
and the old deploy keeps serving.
1. Run `liturgio-tools/sql/make-app-users.sql` on DO as `doadmin`.
2. Add the App Platform env var `LITURGIO_SESSION_SECRET` (type `SECRET`, RUN_TIME),
   set to a fresh `python -c "import secrets; print(secrets.token_urlsafe(48))"`.
   Both instances share it. Rotating it signs everyone out.
3. `python manage_users.py add <you> --role ADMIN --do` (plus any other users).
4. Push to `prod`. Then check that `/` redirects to `/login` and that `/api/stats`
   returns 401 when logged out.
5. **Self-service password changes** (`/profile`) use their own DB user, so
   `liturgio_ro` stays truly read-only. Generate a password
   (`python -c "import secrets; print(secrets.token_urlsafe(32))"`), then on DO as `doadmin`:
   ```sql
   CREATE USER 'liturgio_auth'@'%' IDENTIFIED BY '<generated>';
   GRANT SELECT (user_id, session_epoch, is_active) ON liturgio.app_user TO 'liturgio_auth'@'%';
   GRANT UPDATE (password_hash, session_epoch) ON liturgio.app_user TO 'liturgio_auth'@'%';
   ```
   Then add the App Platform env var `LITURGIO_AUTH_DB_PASSWORD` (type `SECRET`, RUN_TIME),
   and keep a copy in keyring `liturgio-mysql-do` / `liturgio_auth`.
   `liturgio_auth` can't even read password hashes. Only `POST /auth/password` connects
   as it, running one parameterized `UPDATE` on the caller's own row after checking the
   current password. Until the user and the secret both exist, the form returns a 503
   ("not enabled on this server yet"), and `manage_users.py passwd --do` still works.

The local→DO refresh does **not** copy `app_user`, so DO's users, password
hashes and `session_epoch` values survive a refresh. Prod user changes have to be
made on DO with `manage_users.py ... --do`, which writes **only** to DO. Without
`--do`, the command writes only to local. The two user sets are independent.
`p_app_role` is a normal lookup table and is still synced.

## Review queue rollout (in progress, liturgio-api #1)

Prod will record proposed edits in `edit_queue` instead of writing the real
tables; they are reviewed and applied to local by `scripts/apply_queue.py`
(#4). Edits made in the local app bypass the queue. Like `app_user`,
`edit_queue` lives only on DO and `sync_to_do.py` never touches it (its plan
warns when DO's copy is missing or differs from local), so schema changes to
it are applied on DO by hand.
Steps 1–3 done 2026-10-18 (#2); grants verified: SELECT/INSERT on `edit_queue` only.
1. Run `liturgio-tools/sql/make-edit-queue.sql` on DO as `doadmin` (and locally).
2. Create the app's queue user (on DO as `doadmin`, password generated as in step 5 above):
   ```sql
   CREATE USER 'liturgio_queue'@'%' IDENTIFIED BY '<generated>';
   GRANT INSERT, SELECT ON liturgio.edit_queue TO 'liturgio_queue'@'%';
   ```
   No UPDATE/DELETE: a hijacked app or account can add rows but can't rewrite
   or erase history. Keep a copy in keyring `liturgio-mysql-do` / `liturgio_queue`.
3. Add the App Platform env var `LITURGIO_QUEUE_DB_PASSWORD` (type `SECRET`, RUN_TIME).
4. Deploy #3: `POST /api/edit_queue` (exempt from the read-only guard, needs
   `WRITE_LEVEL`) connects as `liturgio_queue`; the chant editor and source
   review show **Submit edit** instead of Save. Without the env var it answers
   503 "not enabled on this server yet". To try the prod UI locally, run the
   server with `LITURGIO_READ_ONLY=1` (submissions go to local `edit_queue`).

## Todos

- [ ] **Decide on App Platform sizing.** The spec runs 2 × `apps-s-1vcpu-1gb`
      (~$24/mo); the original budget assumed one $5 Basic instance.
- [x] **Script the refresh above**: `scripts/sync_to_do.py` (2026-10-16).
      It excludes `app_user`.
- [ ] **Keep the admin IP in Trusted Sources current.** It's a residential IP;
      if it changes, local admin access and the `liturgio-do` MCP server lose
      access until the rule is updated.
- [ ] **Scheduled `mysqldump` to Spaces** with our own retention (e.g. 30
      daily dumps), as a portable backup beyond DO's fixed 7-day window.
- [ ] **Decide whether local `books.image_blob` stays.** It's 464MB and is
      still the local proofreading cache (and the source for uploads); DO
      never receives it.

## Future — write path (review queue): see liturgio-api issue #1 and "Review queue rollout"

- [ ] Review-queue table(s) in the same database, isolated by MySQL grants.
      The public app keeps only the RO credential plus INSERT on the queue,
      and never writes the real tables.
- [ ] A separate full-privilege user for a periodic **manual**
      pull-and-apply sync, held only on the admin machine, Trusted Sources
      limited to the admin IP/VPC; optionally rotate its password after each
      sync.
- [ ] Lift the prod read-only guard (`_read_only_guard` / `rw()` in `app.py`)
      only for the queue endpoints.
