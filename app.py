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
    notes: Optional[str] = None


class ChantDetail(ChantSummary):
    transcriber: Optional[str] = None
    commentary: Optional[str] = None
    gabc: Optional[str] = None
    latin_refs: List[LatinRef] = []
    assignments: List[Assignment] = []


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
                       lpa.wkday, lpa.seq AS lpa_seq,
                       lpa.cycle_sun, lpa.cycle_wk, lpa.notes,
                       lpa.season, lpa.subseason, lpa.wknum,
                       sp.display_name AS part_name, sp.part_code,
                       ld.title AS day_title
                FROM lit_part_assignment lpa
                JOIN service_part sp ON sp.part_id = lpa.part_id
                LEFT JOIN liturgical_day ld ON (
                    ld.season    = lpa.season
                    AND ld.subseason = lpa.subseason
                    AND ld.wknum     = lpa.wknum
                    AND ld.seq       = lpa.seq
                    AND lpa.seq IS NOT NULL
                )
                WHERE lpa.chant_group_id = :gid
                ORDER BY sp.display_order, lpa.jurisdiction,
                         COALESCE(ld.title, lpa.season, '')
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
