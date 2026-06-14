# liturgio-editor

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
  - serves the frontend from `static/` at `/`
- `static/` — frontend (`index.html`, `app.js`, `style.css`)

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

## Run

    uvicorn app:app --reload

Then open http://127.0.0.1:8000/ in a browser.
