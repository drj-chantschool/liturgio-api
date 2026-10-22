# liturgio-api

A small FastAPI + vanilla-JS web UI for browsing and editing English GABC
chant adaptations in the `liturgio` MySQL database (`local_chants`,
`chant_group`, `gregobase_chants`, `lit_part_assignment`).

## Contents

- `app.py` — FastAPI backend:
  - `GET /api/chants` — search/filter `local_chants` (by incipit/canonical
    name, status, part)
  - `GET /api/chants/{chant_id}` — full chant detail, including Latin
    GregoBase references (`latin_refs`) and liturgical-day assignments
  - `PUT /api/chants/{chant_id}` — save an edited GABC body, status,
    translation source, and exactness flag
  - `GET /api/translation_sources` — active translation source codes
  - `GET /api/stats` — counts by status/part
  - **Source review** (`/sources` page):
    - `GET /api/lit_part_sources` — list source texts (filters: `book`,
      `status`, `service_part`, `epoch_slug`, `provenanced`, `q`)
    - `GET /api/lit_part_sources/{text_id}` — one source
    - `PATCH /api/lit_part_sources/{text_id}` — partial update / approve
      (status vocab `draft`/`reviewed`/`published`)
    - `GET /api/books/{book}/{pdf_page_num}/image` — page image (PNG);
      `bbox` coords are in this image's pixel space (dpi=200)
  - serves the frontend from `static/` at `/` and `/sources`
- `static/` — frontend (`index.html`/`app.js` chant editor;
  `sources.html`/`sources.js` source review; shared `style.css`)

## Install

    pip install -r requirements.txt

Depends on [`gabc-tools`](https://github.com/drj-chantschool/gabc-tools)
for `extract_gabc_body()` (used to pull the notation body out of
`gregobase_chants.gabc`, which may be JSON-wrapped or plain
`header\n%%\nbody` text).

The `liturgio` schema itself (DDL + ER diagram) and the CLI/loaders that
populate it live in
[`liturgio-tools`](https://github.com/drj-chantschool/liturgio-tools).

## Database connection

Credentials come from the OS keyring (service `liturgio-mysql`):
read-only user `liturgio_ro` for `GET` endpoints, read-write user `jcost`
for the `PUT /api/chants/{chant_id}` save endpoint. Set them with:

    python -c "import keyring; keyring.set_password('liturgio-mysql', 'liturgio_ro', 'PASSWORD')"
    python -c "import keyring; keyring.set_password('liturgio-mysql', 'jcost', 'PASSWORD')"

## Login and roles

Every page and endpoint requires a login (see `auth.py`). Roles live in
`p_app_role`: `READONLY` can view everything, `EDITOR` can also use the write
endpoints, and `ADMIN` is reserved for user management. Users are managed from
the command line, against local MySQL (the master). Add `--do` to mirror a
change to the DO copy:

    python manage_users.py add jdoe --role EDITOR --name "Jane Doe" [--do]
    python manage_users.py list | roles
    python manage_users.py passwd|disable|enable jdoe [--do]
    python manage_users.py role jdoe ADMIN [--do]

Any signed-in user, whatever their role, can change their own password at
`/profile` (click your name in the header). Changing it signs that user out
everywhere else. On prod this needs its own least-privilege DB user, `liturgio_auth`
(DEPLOYMENT_PLAN.md, login rollout step 5).

Session cookies are signed with `LITURGIO_SESSION_SECRET` (required in prod).

Bots authenticate with `Authorization: Bearer <token>` instead of a cookie
(liturgio-api #6). A token can GET anything and `POST /api/edit_queue`; all
other requests get 403, and `/auth/*` and the profile are always off-limits.
An unknown, revoked or dead token gets 401. Only the token's SHA-256 is stored
(`api_token`). A password change or `disable` kills the user's tokens.

    python manage_users.py add claude-bot --role EDITOR --name "Claude (bot)" --no-password [--do]
    python manage_users.py token create claude-bot --label "nightly job" [--do]   # prints it once
    python manage_users.py token list [claude-bot] [--do]
    python manage_users.py token revoke claude-bot [--id N] [--do]

A revoke takes effect within 30 s (the per-instance cache).
Locally the secret is created in the keyring (`liturgio-api`/`session_secret`)
on first run.

## Run

    uvicorn app:app --reload

Then open http://127.0.0.1:8000/ in a browser.
