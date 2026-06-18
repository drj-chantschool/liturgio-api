from typing import Optional, List
import keyring
from sqlalchemy import create_engine, text
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from gabc_tools.gbchant import extract_gabc_body

app = FastAPI(title="Liturgio Chant Editor")

# Maps both short codes and full GABC header names → canonical short code
PART_NORMALIZE = {
    'in': 'in', 'introit': 'in', 'introitus': 'in',
    'gr': 'gr', 'gradual': 'gr', 'gradualis': 'gr',
    'al': 'al', 'alleluia': 'al',
    'of': 'of', 'offertory': 'of', 'offertorium': 'of',
    'co': 'co', 'communion': 'co', 'communio': 'co',
}

# ── DB ────────────────────────────────────────────────────────────────────────
_engines: dict = {}

def _engine(user: str):
    if user not in _engines:
        pw = keyring.get_password('liturgio-mysql', user)
        if not pw:
            raise RuntimeError(
                f"No keyring entry for liturgio-mysql / {user}. "
                f"Set it with: python -c \"import keyring; "
                f"keyring.set_password('liturgio-mysql', '{user}', 'PASSWORD')\""
            )
        _engines[user] = create_engine(
            f'mysql+mysqlconnector://{user}:{pw}@localhost:3306/liturgio',
            future=True,
            pool_pre_ping=True,
        )
    return _engines[user]

def ro():
    return _engine('liturgio_ro')

def rw():
    return _engine('jcost')


# ── Models ────────────────────────────────────────────────────────────────────
class ChantSummary(BaseModel):
    local_chant_id: str
    chant_group_id: int
    canonical_name: str
    version: Optional[str] = None
    incipit: Optional[str] = None
    part: Optional[str] = None
    mode: Optional[str] = None
    status: Optional[str] = None
    translation_source_code: Optional[str] = None
    is_text_exact: Optional[bool] = None


class LatinRef(BaseModel):
    gregobase_id: int
    incipit: Optional[str] = None
    gabc_body: str
    mode: Optional[str] = None
    version: Optional[str] = None
    part: Optional[str] = None
    transcriber: Optional[str] = None


class Assignment(BaseModel):
    assignment_id: int
    jurisdiction: Optional[str] = None
    authority: Optional[str] = None
    part_name: str
    part_code: Optional[str] = None
    day_title: Optional[str] = None
    season: Optional[str] = None
    subseason: Optional[str] = None
    wknum: Optional[int] = None
    wkday: Optional[int] = None
    lpa_seq: Optional[int] = None
    cycle_sun: Optional[str] = None
    cycle_wk: Optional[str] = None
    option_num: int = 1
    notes: Optional[str] = None


class ChantDetail(ChantSummary):
    transcriber: Optional[str] = None
    commentary: Optional[str] = None
    gabc: Optional[str] = None
    latin_refs: List[LatinRef] = []
    assignments: List[Assignment] = []


class AssignmentCreate(BaseModel):
    jurisdiction: str
    part_id: int
    lit_epoch_slug: Optional[str] = None
    assignment_authority_code: Optional[str] = None
    wkday: Optional[int] = None
    cycle_sun: Optional[str] = None
    cycle_wk: Optional[str] = None
    option_num: int = 1
    notes: Optional[str] = None


class ChantUpdate(BaseModel):
    gabc: str
    status: str
    translation_source_code: Optional[str] = None
    is_text_exact: bool


# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.get("/api/chants", response_model=List[ChantSummary])
def list_chants(
    q: Optional[str] = None,
    status: Optional[str] = None,
    part: Optional[str] = None,
    limit: int = Query(500, le=1000),
    offset: int = 0,
):
    conditions = []
    params: dict = {'limit': limit, 'offset': offset}

    if q:
        conditions.append(
            "(LOWER(lc.incipit) LIKE :q OR LOWER(cg.canonical_name) LIKE :q)"
        )
        params['q'] = f'%{q.lower()}%'
    if status:
        conditions.append("lc.status = :status")
        params['status'] = status
    if part:
        # Match both short codes ('in') and full names ('Introit', 'Introitus')
        equiv = sorted({k for k, v in PART_NORMALIZE.items() if v == part})
        placeholders = ', '.join(f':p{i}' for i in range(len(equiv)))
        conditions.append(f"LOWER(lc.`office-part`) IN ({placeholders})")
        for i, v in enumerate(equiv):
            params[f'p{i}'] = v

    where = ('WHERE ' + ' AND '.join(conditions)) if conditions else ''

    sql = text(f"""
        SELECT lc.local_chant_id, lc.chant_group_id, lc.version, lc.incipit,
               lc.`office-part` AS part, lc.mode, lc.status,
               lc.translation_source_code, lc.is_text_exact,
               cg.canonical_name
        FROM local_chants lc
        JOIN chant_group cg ON cg.chant_group_id = lc.chant_group_id
        {where}
        ORDER BY cg.canonical_name, lc.`office-part`, lc.version
        LIMIT :limit OFFSET :offset
    """)

    try:
        with ro().connect() as conn:
            rows = conn.execute(sql, params).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))

    return [
        ChantSummary(
            local_chant_id=r['local_chant_id'],
            chant_group_id=r['chant_group_id'],
            canonical_name=r['canonical_name'] or '',
            version=r['version'],
            incipit=r['incipit'],
            part=PART_NORMALIZE.get((r['part'] or '').lower(), r['part']),
            mode=r['mode'],
            status=r['status'],
            translation_source_code=r['translation_source_code'],
            is_text_exact=bool(r['is_text_exact']) if r['is_text_exact'] is not None else None,
        )
        for r in rows
    ]


@app.get("/api/chants/{chant_id}", response_model=ChantDetail)
def get_chant(chant_id: str):
    try:
        with ro().connect() as conn:
            row = conn.execute(text("""
                SELECT lc.local_chant_id, lc.chant_group_id, lc.version, lc.incipit,
                       lc.`office-part` AS part, lc.mode, lc.status,
                       lc.translation_source_code, lc.is_text_exact,
                       lc.transcriber, lc.commentary, lc.gabc,
                       cg.canonical_name
                FROM local_chants lc
                JOIN chant_group cg ON cg.chant_group_id = lc.chant_group_id
                WHERE lc.local_chant_id = :id
            """), {'id': chant_id}).mappings().fetchone()

            if not row:
                raise HTTPException(404, "Chant not found")

            latin_rows = conn.execute(text("""
                SELECT gc.id AS gregobase_id, gc.incipit, gc.gabc, gc.mode,
                       gc.version, gc.`office-part` AS part, gc.transcriber
                FROM gregobase_chants gc
                JOIN gregobase_chant_group_map gcm ON gc.id = gcm.gregobase_id
                WHERE gcm.chant_group_id = :gid
                ORDER BY gc.id
            """), {'gid': row['chant_group_id']}).mappings().fetchall()

            assign_rows = conn.execute(text("""
                SELECT lpa.assignment_id, lpa.jurisdiction,
                       lpa.assignment_authority_code,
                       lpa.wkday, le.seq AS lpa_seq,
                       lpa.cycle_sun, lpa.cycle_wk, lpa.option_num,
                       lpa.notes,
                       le.season, le.subseason, le.wknum,
                       sp.display_name AS part_name, sp.part_code,
                       le.title AS day_title
                FROM lit_part_assignment lpa
                JOIN service_part sp ON sp.part_id = lpa.part_id
                LEFT JOIN lit_epoch le ON le.slug = lpa.lit_epoch_slug
                WHERE lpa.chant_group_id = :gid
                ORDER BY sp.display_order, lpa.jurisdiction,
                         COALESCE(le.title, le.season, '')
            """), {'gid': row['chant_group_id']}).mappings().fetchall()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))

    latin_refs = [
        LatinRef(
            gregobase_id=r['gregobase_id'],
            incipit=r['incipit'],
            gabc_body=extract_gabc_body(r['gabc'] or ''),
            mode=r['mode'],
            version=r['version'],
            part=r['part'],
            transcriber=r['transcriber'],
        )
        for r in latin_rows
    ]

    assignments = [
        Assignment(
            assignment_id=r['assignment_id'],
            jurisdiction=r['jurisdiction'],
            authority=r['assignment_authority_code'],
            part_name=r['part_name'],
            part_code=r['part_code'],
            day_title=r['day_title'],
            season=r['season'],
            subseason=r['subseason'],
            wknum=r['wknum'],
            wkday=r['wkday'],
            lpa_seq=r['lpa_seq'],
            cycle_sun=r['cycle_sun'],
            cycle_wk=r['cycle_wk'],
            option_num=r['option_num'],
            notes=r['notes'],
        )
        for r in assign_rows
    ]

    return ChantDetail(
        local_chant_id=row['local_chant_id'],
        chant_group_id=row['chant_group_id'],
        canonical_name=row['canonical_name'] or '',
        version=row['version'],
        incipit=row['incipit'],
        part=PART_NORMALIZE.get((row['part'] or '').lower(), row['part']),
        mode=row['mode'],
        status=row['status'],
        translation_source_code=row['translation_source_code'],
        is_text_exact=bool(row['is_text_exact']) if row['is_text_exact'] is not None else None,
        transcriber=row['transcriber'],
        commentary=row['commentary'],
        gabc=row['gabc'],
        latin_refs=latin_refs,
        assignments=assignments,
    )


@app.put("/api/chants/{chant_id}", response_model=ChantDetail)
def update_chant(chant_id: str, body: ChantUpdate):
    try:
        with rw().begin() as conn:
            result = conn.execute(text("""
                UPDATE local_chants
                SET gabc = :gabc,
                    status = :status,
                    translation_source_code = :src,
                    is_text_exact = :exact
                WHERE local_chant_id = :id
            """), {
                'gabc': body.gabc,
                'status': body.status,
                'src': body.translation_source_code,
                'exact': int(body.is_text_exact),
                'id': chant_id,
            })
            if result.rowcount == 0:
                raise HTTPException(404, "Chant not found")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))

    return get_chant(chant_id)


@app.get("/api/translation_sources")
def list_translation_sources():
    try:
        with ro().connect() as conn:
            rows = conn.execute(text("""
                SELECT translation_source_code, display_name
                FROM p_translation_source
                WHERE is_active = 1
                ORDER BY sort_order
            """)).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))

    return [
        {'code': r['translation_source_code'], 'display_name': r['display_name']}
        for r in rows
    ]


@app.get("/api/service_parts")
def list_service_parts():
    try:
        with ro().connect() as conn:
            rows = conn.execute(text("""
                SELECT part_id, part_code, display_name, service_code
                FROM service_part
                ORDER BY display_order
            """)).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return [dict(r) for r in rows]


@app.get("/api/lit_epochs")
def list_lit_epochs(q: Optional[str] = None, limit: int = Query(50, le=200)):
    conditions = []
    params: dict = {'limit': limit}
    if q:
        conditions.append("(LOWER(le.title) LIKE :q OR LOWER(le.slug) LIKE :q)")
        params['q'] = f'%{q.lower()}%'
    where = ('WHERE ' + ' AND '.join(conditions)) if conditions else ''
    try:
        with ro().connect() as conn:
            rows = conn.execute(text(f"""
                SELECT slug, title, season, subseason, wknum
                FROM lit_epoch le
                {where}
                ORDER BY sort_order, slug
                LIMIT :limit
            """), params).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return [dict(r) for r in rows]


@app.get("/api/lit_epoch_tree")
def lit_epoch_tree():
    try:
        with ro().connect() as conn:
            rows = conn.execute(text("""
                SELECT slug, kind, title, season, subseason, wknum, sort_order
                FROM lit_epoch
                ORDER BY sort_order, slug
            """)).mappings().fetchall()

            date_rows = conn.execute(text("""
                SELECT slug, month_nominal, day_nominal
                FROM proper_of_saints
                WHERE month_nominal IS NOT NULL
            """)).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))

    saint_dates = {}
    for dr in date_rows:
        saint_dates[dr['slug']] = (dr['month_nominal'], dr['day_nominal'])

    seasons = []
    saints = []
    sub_map: dict = {}
    week_map: dict = {}
    day_map: dict = {}

    for r in rows:
        kind = r['kind']
        if kind == 'season':
            seasons.append({
                'slug': r['slug'], 'title': r['title'] or r['slug'],
            })
        elif kind == 'saint':
            entry: dict = {
                'slug': r['slug'], 'title': r['title'] or r['slug'],
            }
            if r['slug'] in saint_dates:
                entry['month'] = saint_dates[r['slug']][0]
                entry['day'] = saint_dates[r['slug']][1]
            saints.append(entry)
        elif kind == 'subseason':
            key = r['season']
            sub_map.setdefault(key, []).append({
                'slug': r['slug'],
                'title': r['title'] or r['subseason'] or r['slug'],
                'subseason': r['subseason'],
            })
        elif kind == 'week':
            key = f"{r['season']}/{r['subseason']}"
            week_map.setdefault(key, []).append({
                'slug': r['slug'],
                'wknum': r['wknum'],
            })
        elif kind in ('day', 'mass'):
            key = f"{r['season']}/{r['subseason']}/{r['wknum']}"
            day_map.setdefault(key, []).append({
                'slug': r['slug'],
                'title': r['title'] or r['slug'],
            })

    return {
        'seasons': seasons,
        'saints': saints,
        'subseasons': sub_map,
        'weeks': week_map,
        'days': day_map,
    }


@app.get("/api/assignment_authorities")
def list_assignment_authorities():
    try:
        with ro().connect() as conn:
            rows = conn.execute(text("""
                SELECT authority_code AS code, display_name
                FROM p_assignment_authority
                WHERE is_active = 1
                ORDER BY sort_order
            """)).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return [dict(r) for r in rows]


@app.post("/api/chant_groups/{group_id}/assignments", response_model=Assignment)
def create_assignment(group_id: int, body: AssignmentCreate):
    try:
        with rw().begin() as conn:
            grp = conn.execute(text(
                "SELECT chant_group_id FROM chant_group WHERE chant_group_id = :gid"
            ), {'gid': group_id}).fetchone()
            if not grp:
                raise HTTPException(404, "Chant group not found")

            result = conn.execute(text("""
                INSERT INTO lit_part_assignment
                    (jurisdiction, part_id, lit_epoch_slug,
                     assignment_authority_code, wkday,
                     cycle_sun, cycle_wk, option_num,
                     chant_group_id, notes)
                VALUES
                    (:jurisdiction, :part_id, :lit_epoch_slug,
                     :authority, :wkday,
                     :cycle_sun, :cycle_wk, :option_num,
                     :gid, :notes)
            """), {
                'jurisdiction': body.jurisdiction,
                'part_id': body.part_id,
                'lit_epoch_slug': body.lit_epoch_slug or None,
                'authority': body.assignment_authority_code or None,
                'wkday': body.wkday,
                'cycle_sun': body.cycle_sun,
                'cycle_wk': body.cycle_wk,
                'option_num': body.option_num,
                'gid': group_id,
                'notes': body.notes or None,
            })
            new_id = result.lastrowid

            row = conn.execute(text("""
                SELECT lpa.assignment_id, lpa.jurisdiction,
                       lpa.assignment_authority_code,
                       lpa.wkday, le.seq AS lpa_seq,
                       lpa.cycle_sun, lpa.cycle_wk, lpa.option_num,
                       lpa.notes,
                       le.season, le.subseason, le.wknum,
                       sp.display_name AS part_name, sp.part_code,
                       le.title AS day_title
                FROM lit_part_assignment lpa
                JOIN service_part sp ON sp.part_id = lpa.part_id
                LEFT JOIN lit_epoch le ON le.slug = lpa.lit_epoch_slug
                WHERE lpa.assignment_id = :aid
            """), {'aid': new_id}).mappings().fetchone()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))

    return Assignment(
        assignment_id=row['assignment_id'],
        jurisdiction=row['jurisdiction'],
        authority=row['assignment_authority_code'],
        part_name=row['part_name'],
        part_code=row['part_code'],
        day_title=row['day_title'],
        season=row['season'],
        subseason=row['subseason'],
        wknum=row['wknum'],
        wkday=row['wkday'],
        lpa_seq=row['lpa_seq'],
        cycle_sun=row['cycle_sun'],
        cycle_wk=row['cycle_wk'],
        option_num=row['option_num'],
        notes=row['notes'],
    )


@app.delete("/api/assignments/{assignment_id}")
def delete_assignment(assignment_id: int):
    try:
        with rw().begin() as conn:
            result = conn.execute(text(
                "DELETE FROM lit_part_assignment WHERE assignment_id = :aid"
            ), {'aid': assignment_id})
            if result.rowcount == 0:
                raise HTTPException(404, "Assignment not found")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return {'ok': True}


@app.get("/api/stats")
def get_stats():
    try:
        with ro().connect() as conn:
            total = conn.execute(text("SELECT COUNT(*) FROM local_chants")).scalar()
            by_status = conn.execute(text(
                "SELECT COALESCE(status,'(none)'), COUNT(*) FROM local_chants GROUP BY status"
            )).fetchall()
            by_part = conn.execute(text(
                "SELECT COALESCE(`office-part`,'(none)'), COUNT(*) FROM local_chants GROUP BY `office-part`"
            )).fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))

    return {
        'total': total,
        'by_status': {r[0]: r[1] for r in by_status},
        'by_part': {r[0]: r[1] for r in by_part},
    }


# ── Static / SPA ──────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return FileResponse("static/index.html")

app.mount("/static", StaticFiles(directory="static"), name="static")
