from typing import Optional, List
import re
from difflib import SequenceMatcher
import keyring
from sqlalchemy import create_engine, text
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
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
    text_id: int
    jurisdiction: Optional[str] = None
    authority: Optional[str] = None
    part_name: str
    part_code: Optional[str] = None
    day_title: Optional[str] = None
    season: Optional[str] = None
    subseason: Optional[str] = None
    wknum: Optional[int] = None
    wkday: Optional[int] = None
    lps_seq: Optional[int] = None
    cycle_sun: Optional[str] = None
    cycle_wkday: Optional[str] = None
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
    cycle_wkday: Optional[str] = None
    option_num: int = 1
    notes: Optional[str] = None


class ChantUpdate(BaseModel):
    gabc: str
    status: str
    translation_source_code: Optional[str] = None
    is_text_exact: bool


class LitPartSource(BaseModel):
    text_id: int
    service_part: str
    part_display_name: Optional[str] = None
    review_status: str
    jurisdiction: str = 'UNIVERSAL'
    option_num: int = 1
    original_text: Optional[str] = None
    vernacular_text: Optional[str] = None
    text_src: Optional[str] = None
    assignment_authority_code: Optional[str] = None
    translation_source_code: Optional[str] = None
    lit_epoch_slug: Optional[str] = None
    epoch_title: Optional[str] = None
    wkday: Optional[int] = None
    cycle_sun: Optional[int] = None
    cycle_wkday: Optional[int] = None
    wknum_mod_4: Optional[int] = None
    wknum_mod_2: Optional[int] = None
    common_of: Optional[str] = None
    notes: Optional[str] = None
    book: Optional[str] = None
    pdf_page_num: Optional[int] = None
    printed_page_num: Optional[str] = None
    bbox: Optional[str] = None
    chant_uuid: Optional[str] = None


class LitPartSourceUpdate(BaseModel):
    # All optional → partial update; only fields actually sent are written.
    # 'service_part' accepts a part_code string (e.g. 'in', 'co') and is
    # converted to part_id internally before the UPDATE is issued.
    review_status: Optional[str] = None
    jurisdiction: Optional[str] = None
    option_num: Optional[int] = None
    original_text: Optional[str] = None
    vernacular_text: Optional[str] = None
    text_src: Optional[str] = None
    service_part: Optional[str] = None   # part_code string; converted to part_id
    lit_epoch_slug: Optional[str] = None
    wkday: Optional[int] = None
    bbox: Optional[str] = None
    notes: Optional[str] = None
    chant_uuid: Optional[str] = None


class LitPartAssignmentReview(BaseModel):
    text_id: int
    jurisdiction: str = 'UNIVERSAL'
    part_id: int
    part_code: Optional[str] = None
    part_name: str
    lit_epoch_slug: Optional[str] = None
    epoch_title: Optional[str] = None
    wkday: Optional[int] = None
    cycle_sun: Optional[int] = None
    cycle_wkday: Optional[int] = None
    option_num: int = 1
    chant_uuid: Optional[str] = None
    chant_group_id: Optional[int] = None
    chant_name: Optional[str] = None
    assignment_authority_code: Optional[str] = None
    notes: Optional[str] = None
    review_status: str = 'draft'


class ChantGroupSummary(BaseModel):
    chant_group_id: int
    canonical_name: str
    incipit: Optional[str] = None
    incipit_clean: Optional[str] = None
    mode: Optional[str] = None
    office_part: Optional[str] = None
    rep_incipit: Optional[str] = None
    rep_gabc_body: Optional[str] = None
    chant_count: int = 0


class MergeQueuePair(BaseModel):
    group_a: ChantGroupSummary
    group_b: ChantGroupSummary
    similarity: float


class ChantGroupNameUpdate(BaseModel):
    canonical_name: str


class MergeRequest(BaseModel):
    keep_id: int
    merge_id: int


class RejectRequest(BaseModel):
    group_id_a: int
    group_id_b: int


class ChantInGroup(BaseModel):
    source: str          # 'local' or 'gregobase'
    chant_id: str        # local_chant_id or str(gregobase_id)
    incipit: Optional[str] = None
    gabc: Optional[str] = None   # full GABC (local) or body only (gregobase)
    gabc_is_body: bool = False
    mode: Optional[str] = None
    version: Optional[str] = None
    status: Optional[str] = None       # local only
    transcriber: Optional[str] = None  # gregobase only


class LitPartAssignmentUpdate(BaseModel):
    review_status: Optional[str] = None   # 'draft' / 'reviewed' / 'published'
    notes: Optional[str] = None
    assignment_authority_code: Optional[str] = None
    lit_epoch_slug: Optional[str] = None
    wkday: Optional[int] = None
    cycle_sun: Optional[int] = None
    cycle_wkday: Optional[int] = None
    option_num: Optional[int] = None
    jurisdiction: Optional[str] = None
    part_id: Optional[int] = None
    chant_uuid: Optional[str] = None


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
                SELECT lps.text_id, lps.jurisdiction,
                       lps.assignment_authority_code,
                       lps.wkday, le.seq AS lps_seq,
                       lps.cycle_sun, lps.cycle_wkday, lps.option_num,
                       lps.notes,
                       le.season, le.subseason, le.wknum,
                       sp.display_name AS part_name, sp.part_code,
                       le.title AS day_title
                FROM lit_part_sources lps
                JOIN service_part sp ON sp.part_id = lps.part_id
                LEFT JOIN lit_epoch le ON le.slug = lps.lit_epoch_slug
                LEFT JOIN gregobase_chant_group_map gcm
                       ON lps.chant_uuid LIKE 'gregobase:%%'
                      AND gcm.gregobase_id = CAST(SUBSTRING(lps.chant_uuid, 11) AS UNSIGNED)
                LEFT JOIN local_chants lc
                       ON lps.chant_uuid LIKE 'local:%%'
                      AND lc.local_chant_id = SUBSTRING(lps.chant_uuid, 7)
                WHERE COALESCE(gcm.chant_group_id, lc.chant_group_id) = :gid
                ORDER BY sp.display_order, lps.jurisdiction,
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
            text_id=r['text_id'],
            jurisdiction=r['jurisdiction'],
            authority=r['assignment_authority_code'],
            part_name=r['part_name'],
            part_code=r['part_code'],
            day_title=r['day_title'],
            season=r['season'],
            subseason=r['subseason'],
            wknum=r['wknum'],
            wkday=r['wkday'],
            lps_seq=r['lps_seq'],
            cycle_sun=r['cycle_sun'],
            cycle_wkday=r['cycle_wkday'],
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

            # Find a representative chant_uuid for this group (gregobase preferred).
            uuid_row = conn.execute(text("""
                SELECT CONCAT('gregobase:', MIN(gregobase_id)) AS cu
                FROM gregobase_chant_group_map WHERE chant_group_id = :gid
            """), {'gid': group_id}).fetchone()
            chant_uuid = uuid_row[0] if uuid_row and uuid_row[0] else None
            if chant_uuid is None:
                lc_row = conn.execute(text("""
                    SELECT CONCAT('local:', local_chant_id) AS cu
                    FROM local_chants WHERE chant_group_id = :gid LIMIT 1
                """), {'gid': group_id}).fetchone()
                chant_uuid = lc_row[0] if lc_row else None

            result = conn.execute(text("""
                INSERT INTO lit_part_sources
                    (jurisdiction, part_id, lit_epoch_slug,
                     assignment_authority_code, wkday,
                     cycle_sun, cycle_wkday, option_num,
                     chant_uuid, notes, review_status)
                VALUES
                    (:jurisdiction, :part_id, :lit_epoch_slug,
                     :authority, :wkday,
                     :cycle_sun, :cycle_wkday, :option_num,
                     :chant_uuid, :notes, 'draft')
            """), {
                'jurisdiction': body.jurisdiction,
                'part_id': body.part_id,
                'lit_epoch_slug': body.lit_epoch_slug or None,
                'authority': body.assignment_authority_code or None,
                'wkday': body.wkday,
                'cycle_sun': body.cycle_sun,
                'cycle_wkday': body.cycle_wkday,
                'option_num': body.option_num,
                'chant_uuid': chant_uuid,
                'notes': body.notes or None,
            })
            new_id = result.lastrowid

            row = conn.execute(text("""
                SELECT lps.text_id, lps.jurisdiction,
                       lps.assignment_authority_code,
                       lps.wkday, le.seq AS lps_seq,
                       lps.cycle_sun, lps.cycle_wkday, lps.option_num,
                       lps.notes,
                       le.season, le.subseason, le.wknum,
                       sp.display_name AS part_name, sp.part_code,
                       le.title AS day_title
                FROM lit_part_sources lps
                JOIN service_part sp ON sp.part_id = lps.part_id
                LEFT JOIN lit_epoch le ON le.slug = lps.lit_epoch_slug
                WHERE lps.text_id = :tid
            """), {'tid': new_id}).mappings().fetchone()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))

    return Assignment(
        text_id=row['text_id'],
        jurisdiction=row['jurisdiction'],
        authority=row['assignment_authority_code'],
        part_name=row['part_name'],
        part_code=row['part_code'],
        day_title=row['day_title'],
        season=row['season'],
        subseason=row['subseason'],
        wknum=row['wknum'],
        wkday=row['wkday'],
        lps_seq=row['lps_seq'],
        cycle_sun=row['cycle_sun'],
        cycle_wkday=row['cycle_wkday'],
        option_num=row['option_num'],
        notes=row['notes'],
    )


@app.delete("/api/assignments/{text_id}")
def delete_assignment(text_id: int):
    try:
        with rw().begin() as conn:
            result = conn.execute(text(
                "DELETE FROM lit_part_sources WHERE text_id = :tid"
            ), {'tid': text_id})
            if result.rowcount == 0:
                raise HTTPException(404, "Source/assignment not found")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return {'ok': True}


# ── lit_part_sources review ────────────────────────────────────────────────────
_LPS_SELECT = """
    SELECT lps.text_id, sp.part_code AS service_part, sp.display_name AS part_display_name,
           lps.review_status, lps.jurisdiction, lps.option_num,
           lps.original_text, lps.vernacular_text, lps.text_src,
           lps.assignment_authority_code, lps.translation_source_code,
           lps.lit_epoch_slug, le.title AS epoch_title,
           lps.wkday, lps.cycle_sun, lps.cycle_wkday,
           lps.wknum_mod_4, lps.wknum_mod_2,
           lps.common_of, lps.notes,
           lps.book, lps.pdf_page_num, b.printed_page_num, lps.bbox,
           lps.chant_uuid
    FROM lit_part_sources lps
    JOIN service_part sp ON sp.part_id = lps.part_id
    LEFT JOIN lit_epoch le ON le.slug = lps.lit_epoch_slug
    LEFT JOIN books b ON b.book = lps.book AND b.pdf_page_num = lps.pdf_page_num
"""


def _lps_from_row(r) -> LitPartSource:
    return LitPartSource(
        text_id=r['text_id'],
        service_part=r['service_part'],
        part_display_name=r['part_display_name'],
        review_status=r['review_status'],
        jurisdiction=r['jurisdiction'] or 'UNIVERSAL',
        option_num=r['option_num'] or 1,
        original_text=r['original_text'],
        vernacular_text=r['vernacular_text'],
        text_src=r['text_src'],
        assignment_authority_code=r['assignment_authority_code'],
        translation_source_code=r['translation_source_code'],
        lit_epoch_slug=r['lit_epoch_slug'],
        epoch_title=r['epoch_title'],
        wkday=r['wkday'],
        cycle_sun=r['cycle_sun'],
        cycle_wkday=r['cycle_wkday'],
        wknum_mod_4=r['wknum_mod_4'],
        wknum_mod_2=r['wknum_mod_2'],
        common_of=r['common_of'],
        notes=r['notes'],
        book=r['book'],
        pdf_page_num=r['pdf_page_num'],
        printed_page_num=r['printed_page_num'],
        bbox=r['bbox'],
        chant_uuid=r['chant_uuid'],
    )


@app.get("/api/lit_part_sources", response_model=List[LitPartSource])
def list_lit_part_sources(
    book: Optional[str] = None,
    review_status: Optional[str] = None,
    service_part: Optional[str] = None,
    epoch_slug: Optional[str] = None,
    provenanced: Optional[bool] = None,
    q: Optional[str] = None,
    limit: int = Query(500, le=2000),
    offset: int = 0,
):
    conditions = []
    params: dict = {'limit': limit, 'offset': offset}
    if book:
        conditions.append("lps.book = :book")
        params['book'] = book
    if review_status:
        conditions.append("lps.review_status = :review_status")
        params['review_status'] = review_status
    if service_part:
        # Accept part_code string (e.g. 'in', 'co'); translate to part_id FK.
        conditions.append("sp.part_code = :service_part")
        params['service_part'] = service_part
    if epoch_slug:
        conditions.append("lps.lit_epoch_slug = :epoch_slug")
        params['epoch_slug'] = epoch_slug
    if provenanced is True:
        conditions.append("lps.book IS NOT NULL AND lps.pdf_page_num IS NOT NULL")
    elif provenanced is False:
        conditions.append("lps.book IS NULL")
    if q:
        conditions.append(
            "(LOWER(lps.original_text) LIKE :q OR LOWER(lps.text_src) LIKE :q "
            "OR LOWER(lps.lit_epoch_slug) LIKE :q)"
        )
        params['q'] = f'%{q.lower()}%'

    where = ('WHERE ' + ' AND '.join(conditions)) if conditions else ''
    sql = text(f"""
        {_LPS_SELECT}
        {where}
        ORDER BY lps.book, lps.pdf_page_num,
                 COALESCE(CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(lps.bbox, ',', 2), ',', -1) AS UNSIGNED), 999999),
                 COALESCE(sp.display_order, 999), lps.text_id
        LIMIT :limit OFFSET :offset
    """)
    try:
        with ro().connect() as conn:
            rows = conn.execute(sql, params).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return [_lps_from_row(r) for r in rows]


@app.get("/api/lit_part_sources/{text_id}", response_model=LitPartSource)
def get_lit_part_source(text_id: int):
    try:
        with ro().connect() as conn:
            row = conn.execute(
                text(f"{_LPS_SELECT} WHERE lps.text_id = :tid"),
                {'tid': text_id},
            ).mappings().fetchone()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    if not row:
        raise HTTPException(404, "Source not found")
    return _lps_from_row(row)


@app.patch("/api/lit_part_sources/{text_id}", response_model=LitPartSource)
def update_lit_part_source(text_id: int, body: LitPartSourceUpdate):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "No fields to update")

    # review_status → column name matches directly; no transformation needed.

    # Convert service_part (part_code string) → part_id (int FK) if present.
    if 'service_part' in fields:
        part_code_val = fields.pop('service_part')
        if part_code_val is None:
            raise HTTPException(400, "service_part cannot be set to null")
        try:
            with ro().connect() as conn:
                pid = conn.execute(
                    text("SELECT part_id FROM service_part WHERE part_code = :code"),
                    {'code': part_code_val},
                ).scalar()
        except Exception as exc:
            raise HTTPException(503, str(exc))
        if pid is None:
            raise HTTPException(400, f"Unknown service_part code: {part_code_val!r}")
        fields['part_id'] = pid

    set_clause = ", ".join(f"{col} = :{col}" for col in fields)
    params = dict(fields)
    params['tid'] = text_id
    try:
        with rw().begin() as conn:
            result = conn.execute(
                text(f"UPDATE lit_part_sources SET {set_clause} WHERE text_id = :tid"),
                params,
            )
            if result.rowcount == 0:
                # rowcount 0 can mean "not found" or "no change"; disambiguate.
                exists = conn.execute(
                    text("SELECT 1 FROM lit_part_sources WHERE text_id = :tid"),
                    {'tid': text_id},
                ).fetchone()
                if not exists:
                    raise HTTPException(404, "Source not found")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return get_lit_part_source(text_id)


# ── chant lookup by chant_uuid ────────────────────────────────────────────────

class ChantUuidResult(BaseModel):
    chant_uuid: str
    incipit: Optional[str] = None
    gabc_body: str          # GABC body text ready for exsurge rendering
    mode: Optional[str] = None
    version: Optional[str] = None


@app.get("/api/chant_by_uuid", response_model=ChantUuidResult)
def get_chant_by_uuid(uuid: str):
    """Return GABC body for a chant referenced by a lit_part_sources.chant_uuid value.

    Accepts 'gregobase:<id>' (resolved from gregobase_chants) or
    'local:<local_chant_id>' (resolved from local_chants).
    """
    if uuid.startswith("gregobase:"):
        try:
            gid = int(uuid.split(":", 1)[1])
        except ValueError:
            raise HTTPException(400, "Invalid gregobase chant_uuid")
        try:
            with ro().connect() as conn:
                row = conn.execute(text("""
                    SELECT id, incipit, gabc, mode, version
                    FROM gregobase_chants
                    WHERE id = :gid
                """), {'gid': gid}).mappings().fetchone()
        except Exception as exc:
            raise HTTPException(503, str(exc))
        if not row:
            raise HTTPException(404, f"gregobase chant {gid} not found")
        return ChantUuidResult(
            chant_uuid=uuid,
            incipit=row['incipit'],
            gabc_body=extract_gabc_body(row['gabc'] or ''),
            mode=row['mode'],
            version=row['version'],
        )
    elif uuid.startswith("local:"):
        lid = uuid.split(":", 1)[1]
        try:
            with ro().connect() as conn:
                row = conn.execute(text("""
                    SELECT local_chant_id, incipit, gabc, mode, version
                    FROM local_chants
                    WHERE local_chant_id = :lid
                """), {'lid': lid}).mappings().fetchone()
        except Exception as exc:
            raise HTTPException(503, str(exc))
        if not row:
            raise HTTPException(404, f"local chant {lid!r} not found")
        # local_chants.gabc uses the '%%' separator format (not JSON)
        gabc = row['gabc'] or ''
        parts = gabc.split('%%')
        gabc_body = parts[-1].strip() if len(parts) > 1 else gabc.strip()
        return ChantUuidResult(
            chant_uuid=uuid,
            incipit=row['incipit'],
            gabc_body=gabc_body,
            mode=row['mode'],
            version=row['version'],
        )
    else:
        raise HTTPException(400, "chant_uuid must start with 'gregobase:' or 'local:'")


# ── lit_part_sources as assignment review ──────────────────────────────────────
# Joins through chant_uuid to derive chant_group_id; filters to rows that have
# a chant_uuid (i.e. genuine chant assignments, not text-only source rows).
_LPS_ASSIGN_SELECT = """
    SELECT lps.text_id, lps.jurisdiction,
           lps.assignment_authority_code,
           lps.lit_epoch_slug, le.title AS epoch_title,
           lps.wkday, lps.cycle_sun, lps.cycle_wkday, lps.option_num,
           lps.chant_uuid,
           COALESCE(gcm.chant_group_id, lc.chant_group_id) AS chant_group_id,
           cg.canonical_name AS chant_name,
           lps.review_status, lps.notes,
           sp.part_id, sp.part_code, sp.display_name AS part_name,
           sp.display_order AS part_order,
           COALESCE(le.sort_order, 9999) AS epoch_sort
    FROM lit_part_sources lps
    JOIN service_part sp ON sp.part_id = lps.part_id
    LEFT JOIN lit_epoch le ON le.slug = lps.lit_epoch_slug
    LEFT JOIN gregobase_chant_group_map gcm
           ON lps.chant_uuid LIKE 'gregobase:%%'
          AND gcm.gregobase_id = CAST(SUBSTRING(lps.chant_uuid, 11) AS UNSIGNED)
    LEFT JOIN local_chants lc
           ON lps.chant_uuid LIKE 'local:%%'
          AND lc.local_chant_id = SUBSTRING(lps.chant_uuid, 7)
    LEFT JOIN chant_group cg
           ON cg.chant_group_id = COALESCE(gcm.chant_group_id, lc.chant_group_id)
"""


def _lps_as_assign_from_row(r) -> LitPartAssignmentReview:
    return LitPartAssignmentReview(
        text_id=r['text_id'],
        jurisdiction=r['jurisdiction'] or 'UNIVERSAL',
        part_id=r['part_id'],
        part_code=r['part_code'],
        part_name=r['part_name'],
        lit_epoch_slug=r['lit_epoch_slug'],
        epoch_title=r['epoch_title'],
        wkday=r['wkday'],
        cycle_sun=r['cycle_sun'],
        cycle_wkday=r['cycle_wkday'],
        option_num=r['option_num'] or 1,
        chant_uuid=r['chant_uuid'],
        chant_group_id=r['chant_group_id'],
        chant_name=r['chant_name'],
        assignment_authority_code=r['assignment_authority_code'],
        notes=r['notes'],
        review_status=r['review_status'] or 'draft',
    )


@app.get("/api/lit_part_assignments", response_model=List[LitPartAssignmentReview])
def list_lit_part_assignments(
    review_status: Optional[str] = None,
    jurisdiction: Optional[str] = None,
    part_code: Optional[str] = None,
    epoch_slug: Optional[str] = None,
    authority_code: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = Query(500, le=1000),
    offset: int = 0,
):
    # Default: only rows that have a chant assigned (mirrors old lpa behaviour).
    conditions = ["lps.chant_uuid IS NOT NULL"]
    params: dict = {'limit': limit, 'offset': offset}
    if review_status:
        conditions.append("lps.review_status = :review_status")
        params['review_status'] = review_status
    if jurisdiction:
        conditions.append("lps.jurisdiction = :jurisdiction")
        params['jurisdiction'] = jurisdiction
    if part_code:
        conditions.append("sp.part_code = :part_code")
        params['part_code'] = part_code
    if authority_code == '(none)':
        conditions.append("lps.assignment_authority_code IS NULL")
    elif authority_code:
        conditions.append("lps.assignment_authority_code = :authority_code")
        params['authority_code'] = authority_code
    if epoch_slug:
        conditions.append("lps.lit_epoch_slug = :epoch_slug")
        params['epoch_slug'] = epoch_slug
    if q:
        conditions.append(
            "(LOWER(cg.canonical_name) LIKE :q OR LOWER(lps.lit_epoch_slug) LIKE :q "
            "OR LOWER(le.title) LIKE :q OR LOWER(lps.notes) LIKE :q)"
        )
        params['q'] = f'%{q.lower()}%'
    where = 'WHERE ' + ' AND '.join(conditions)
    sql = text(f"""
        {_LPS_ASSIGN_SELECT}
        {where}
        ORDER BY lps.jurisdiction, sp.display_order, epoch_sort, lps.option_num
        LIMIT :limit OFFSET :offset
    """)
    try:
        with ro().connect() as conn:
            rows = conn.execute(sql, params).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return [_lps_as_assign_from_row(r) for r in rows]


@app.get("/api/lit_part_assignments/{text_id}", response_model=LitPartAssignmentReview)
def get_lit_part_assignment(text_id: int):
    try:
        with ro().connect() as conn:
            row = conn.execute(
                text(f"{_LPS_ASSIGN_SELECT} WHERE lps.text_id = :tid"),
                {'tid': text_id},
            ).mappings().fetchone()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    if not row:
        raise HTTPException(404, "Assignment not found")
    return _lps_as_assign_from_row(row)


@app.patch("/api/lit_part_assignments/{text_id}", response_model=LitPartAssignmentReview)
def update_lit_part_assignment(text_id: int, body: LitPartAssignmentUpdate):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "No fields to update")
    set_clause = ", ".join(f"{col} = :{col}" for col in fields)
    params = dict(fields)
    params['tid'] = text_id
    try:
        with rw().begin() as conn:
            result = conn.execute(
                text(f"UPDATE lit_part_sources SET {set_clause} WHERE text_id = :tid"),
                params,
            )
            if result.rowcount == 0:
                exists = conn.execute(
                    text("SELECT 1 FROM lit_part_sources WHERE text_id = :tid"),
                    {'tid': text_id},
                ).fetchone()
                if not exists:
                    raise HTTPException(404, "Assignment not found")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return get_lit_part_assignment(text_id)


@app.get("/api/lit_epochs")
def list_lit_epochs(
    kind: Optional[str] = None,
    season: Optional[str] = None,
    subseason: Optional[str] = None,
    wknum: Optional[str] = None,
):
    conditions = []
    params: dict = {}
    if kind:
        conditions.append("kind = :kind")
        params['kind'] = kind
    if season:
        conditions.append("season = :season")
        params['season'] = season
    if subseason:
        conditions.append("subseason = :subseason")
        params['subseason'] = subseason
    if wknum:
        conditions.append("wknum = :wknum")
        params['wknum'] = wknum
    where = ('WHERE ' + ' AND '.join(conditions)) if conditions else ''
    try:
        with ro().connect() as conn:
            rows = conn.execute(text(f"""
                SELECT slug, kind, title, season, subseason, wknum, sort_order
                FROM lit_epoch
                {where}
                ORDER BY sort_order, slug
            """), params).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return [dict(r) for r in rows]


@app.get("/api/lit_epochs/{slug}/assignments_review")
def lit_epoch_assignments_review(slug: str):
    try:
        with ro().connect() as conn:
            epoch_row = conn.execute(text("""
                SELECT slug, kind, title, season, subseason, wknum, sort_order
                FROM lit_epoch WHERE slug = :s
            """), {'s': slug}).mappings().fetchone()
            if not epoch_row:
                raise HTTPException(404, "Epoch not found")
            epoch = dict(epoch_row)
            kind = epoch['kind']

            # Compute ancestor slugs (outermost first)
            ancestor_slugs: list = []
            if kind in ('day', 'mass', 'week', 'subseason') and epoch['season']:
                row = conn.execute(text(
                    "SELECT slug FROM lit_epoch WHERE kind = 'season' AND season = :s LIMIT 1"
                ), {'s': epoch['season']}).fetchone()
                if row:
                    ancestor_slugs.append(row[0])
            if kind in ('day', 'mass', 'week') and epoch['season'] and epoch['subseason']:
                row = conn.execute(text(
                    "SELECT slug FROM lit_epoch WHERE kind = 'subseason'"
                    " AND season = :s AND subseason = :ss LIMIT 1"
                ), {'s': epoch['season'], 'ss': epoch['subseason']}).fetchone()
                if row:
                    ancestor_slugs.append(row[0])
            if kind in ('day', 'mass') and epoch['season'] and epoch['subseason'] and epoch['wknum']:
                row = conn.execute(text(
                    "SELECT slug FROM lit_epoch WHERE kind = 'week'"
                    " AND season = :s AND subseason = :ss AND wknum = :w LIMIT 1"
                ), {'s': epoch['season'], 'ss': epoch['subseason'], 'w': epoch['wknum']}).fetchone()
                if row:
                    ancestor_slugs.append(row[0])

            # Fetch ancestor assignments
            ancestor_assignments: list = []
            if ancestor_slugs:
                in_ph = ', '.join(f':a{i}' for i in range(len(ancestor_slugs)))
                in_params = {f'a{i}': s for i, s in enumerate(ancestor_slugs)}
                anc_rows = conn.execute(text(f"""
                    {_LPS_ASSIGN_SELECT}
                    WHERE lps.lit_epoch_slug IN ({in_ph})
                    ORDER BY sp.display_order, lps.jurisdiction, lps.option_num
                """), in_params).mappings().fetchall()
                ancestor_assignments = [_lps_as_assign_from_row(r) for r in anc_rows]

            # Fetch this epoch's own assignments
            own_rows = conn.execute(text(f"""
                {_LPS_ASSIGN_SELECT}
                WHERE lps.lit_epoch_slug = :slug
                ORDER BY sp.display_order, lps.jurisdiction, lps.option_num
            """), {'slug': slug}).mappings().fetchall()
            own_assignments = [_lps_as_assign_from_row(r) for r in own_rows]

            # Inherited = ancestor assignments whose (part, juris, wkday, option, cycles) key
            # is NOT present at this exact epoch
            own_keys = {
                (a.part_id, a.jurisdiction, a.wkday, a.option_num, a.cycle_sun, a.cycle_wkday)
                for a in own_assignments
            }
            inherited = [
                a.model_dump()
                for a in ancestor_assignments
                if (a.part_id, a.jurisdiction, a.wkday, a.option_num, a.cycle_sun, a.cycle_wkday)
                not in own_keys
            ]

            # Descendant epochs in sort_order (approximates depth-first traversal)
            kind_order = {'season': 0, 'subseason': 1, 'week': 2, 'day': 3, 'mass': 3, 'saint': 0}
            selected_depth = kind_order.get(kind, 0)
            descendant_epochs: list = []
            if kind == 'season' and epoch['season']:
                desc_rows = conn.execute(text("""
                    SELECT slug, kind, title, sort_order
                    FROM lit_epoch
                    WHERE season = :s AND kind != 'season'
                    ORDER BY sort_order, slug
                """), {'s': epoch['season']}).mappings().fetchall()
                descendant_epochs = [dict(r) for r in desc_rows]
            elif kind == 'subseason' and epoch['season'] and epoch['subseason']:
                desc_rows = conn.execute(text("""
                    SELECT slug, kind, title, sort_order
                    FROM lit_epoch
                    WHERE season = :s AND subseason = :ss AND kind IN ('week', 'day', 'mass')
                    ORDER BY sort_order, slug
                """), {'s': epoch['season'], 'ss': epoch['subseason']}).mappings().fetchall()
                descendant_epochs = [dict(r) for r in desc_rows]
            elif kind == 'week' and epoch['season'] and epoch['subseason'] and epoch['wknum']:
                desc_rows = conn.execute(text("""
                    SELECT slug, kind, title, sort_order
                    FROM lit_epoch
                    WHERE season = :s AND subseason = :ss AND wknum = :w
                      AND kind IN ('day', 'mass')
                    ORDER BY sort_order, slug
                """), {'s': epoch['season'], 'ss': epoch['subseason'],
                       'w': epoch['wknum']}).mappings().fetchall()
                descendant_epochs = [dict(r) for r in desc_rows]

            # Fetch descendant assignments grouped by epoch
            child_by_epoch: dict = {}
            if descendant_epochs:
                desc_slugs = [e['slug'] for e in descendant_epochs]
                in_ph2 = ', '.join(f':d{i}' for i in range(len(desc_slugs)))
                in_params2 = {f'd{i}': s for i, s in enumerate(desc_slugs)}
                child_rows = conn.execute(text(f"""
                    {_LPS_ASSIGN_SELECT}
                    WHERE lps.lit_epoch_slug IN ({in_ph2})
                    ORDER BY sp.display_order, lps.jurisdiction, lps.option_num
                """), in_params2).mappings().fetchall()
                for r in child_rows:
                    a = _lps_as_assign_from_row(r)
                    child_by_epoch.setdefault(a.lit_epoch_slug, []).append(a.model_dump())

            # Collect all parts seen (own + children) with their display_order
            po_rows = conn.execute(text(
                "SELECT part_id, display_order FROM service_part"
            )).mappings().fetchall()
            part_order_map = {r['part_id']: r['display_order'] for r in po_rows}

            all_parts: dict = {}
            for a in own_assignments:
                if a.part_id not in all_parts:
                    all_parts[a.part_id] = (a.part_code, a.part_name)
            for e in descendant_epochs:
                for a_d in child_by_epoch.get(e['slug'], []):
                    pid = a_d['part_id']
                    if pid not in all_parts:
                        all_parts[pid] = (a_d['part_code'], a_d['part_name'])

            by_part = []
            for part_id in sorted(all_parts, key=lambda pid: part_order_map.get(pid, pid)):
                part_code, part_name = all_parts[part_id]
                assignments = []
                for a in own_assignments:
                    if a.part_id == part_id:
                        d = a.model_dump()
                        d['depth'] = 0
                        assignments.append(d)
                for e in descendant_epochs:
                    depth = max(1, kind_order.get(e['kind'], 3) - selected_depth)
                    for a_d in child_by_epoch.get(e['slug'], []):
                        if a_d['part_id'] == part_id:
                            d = dict(a_d)
                            d['depth'] = depth
                            assignments.append(d)
                by_part.append({
                    'part_id': part_id,
                    'part_code': part_code,
                    'part_name': part_name,
                    'assignments': assignments,
                })

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))

    return {'epoch': epoch, 'inherited': inherited, 'by_part': by_part}


@app.get("/api/chant_groups/{group_id}/chants", response_model=List[ChantInGroup])
def list_chants_in_group(group_id: int):
    try:
        with ro().connect() as conn:
            local_rows = conn.execute(text("""
                SELECT local_chant_id, incipit, gabc, mode, version, status
                FROM local_chants
                WHERE chant_group_id = :gid
                ORDER BY version, local_chant_id
            """), {'gid': group_id}).mappings().fetchall()

            gb_rows = conn.execute(text("""
                SELECT gc.id AS gregobase_id, gc.incipit, gc.gabc,
                       gc.mode, gc.version, gc.transcriber
                FROM gregobase_chants gc
                JOIN gregobase_chant_group_map gcm ON gc.id = gcm.gregobase_id
                WHERE gcm.chant_group_id = :gid
                ORDER BY gc.id
            """), {'gid': group_id}).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))

    result: List[ChantInGroup] = []
    for r in local_rows:
        result.append(ChantInGroup(
            source='local',
            chant_id=r['local_chant_id'],
            incipit=r['incipit'],
            gabc=r['gabc'],
            gabc_is_body=False,
            mode=r['mode'],
            version=r['version'],
            status=r['status'],
        ))
    for r in gb_rows:
        result.append(ChantInGroup(
            source='gregobase',
            chant_id=str(r['gregobase_id']),
            incipit=r['incipit'],
            gabc=extract_gabc_body(r['gabc'] or ''),
            gabc_is_body=True,
            mode=r['mode'],
            version=r['version'],
            transcriber=r['transcriber'],
        ))
    return result


@app.get("/api/books/{book}/{pdf_page_num}/image")
def get_book_page_image(book: str, pdf_page_num: int):
    try:
        with ro().connect() as conn:
            row = conn.execute(text("""
                SELECT image_blob FROM books
                WHERE book = :book AND pdf_page_num = :pg
            """), {'book': book, 'pg': pdf_page_num}).fetchone()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    if not row or row[0] is None:
        raise HTTPException(404, "Page image not found")
    return Response(
        content=bytes(row[0]),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


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


# ── Merge Manager ─────────────────────────────────────────────────────────────

_RE_PAREN = re.compile(r'\s*\([^)]*\)\s*')
_RE_TAG   = re.compile(r'\s*<[^>]*>\s*')
_RE_WS    = re.compile(r'\s+')
_MERGE_SIM_THRESHOLD = 0.82


def _clean_incipit(s: str) -> str:
    """Strip parenthetical qualifiers and HTML tags for similarity comparison."""
    s = _RE_PAREN.sub(' ', s)
    s = _RE_TAG.sub(' ', s)
    return _RE_WS.sub(' ', s).strip().lower()


@app.get("/api/chant_groups/{group_id}/summary", response_model=ChantGroupSummary)
def get_chant_group_summary(group_id: int):
    try:
        with ro().connect() as conn:
            row = conn.execute(text("""
                SELECT chant_group_id, canonical_name, incipit
                FROM chant_group WHERE chant_group_id = :gid
            """), {'gid': group_id}).mappings().fetchone()
            if not row:
                raise HTTPException(404, "Chant group not found")

            rep = conn.execute(text("""
                SELECT gc.incipit AS rep_incipit, gc.gabc AS rep_gabc,
                       gc.`office-part` AS office_part, gc.mode AS mode
                FROM gregobase_chant_group_map m
                JOIN gregobase_chants gc ON gc.id = m.gregobase_id
                WHERE m.chant_group_id = :gid AND gc.gabc IS NOT NULL
                ORDER BY gc.id LIMIT 1
            """), {'gid': group_id}).mappings().fetchone()

            gb_count = conn.execute(text(
                "SELECT COUNT(*) FROM gregobase_chant_group_map WHERE chant_group_id = :gid"
            ), {'gid': group_id}).scalar() or 0

            lc_count = conn.execute(text(
                "SELECT COUNT(*) FROM local_chants WHERE chant_group_id = :gid"
            ), {'gid': group_id}).scalar() or 0
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))

    inc = row['incipit'] or ''
    return ChantGroupSummary(
        chant_group_id=row['chant_group_id'],
        canonical_name=row['canonical_name'],
        incipit=inc,
        incipit_clean=_clean_incipit(inc) if inc else None,
        mode=rep['mode'] if rep else None,
        office_part=PART_NORMALIZE.get((rep['office_part'] or '').lower()) if rep else None,
        rep_incipit=rep['rep_incipit'] if rep else None,
        rep_gabc_body=extract_gabc_body(rep['rep_gabc'] or '') if rep else None,
        chant_count=gb_count + lc_count,
    )


@app.patch("/api/chant_groups/{group_id}/name")
def update_chant_group_name(group_id: int, body: ChantGroupNameUpdate):
    name = body.canonical_name.strip()
    if not name:
        raise HTTPException(400, "canonical_name cannot be empty")
    try:
        with rw().begin() as conn:
            result = conn.execute(text("""
                UPDATE chant_group SET canonical_name = :name
                WHERE chant_group_id = :gid
            """), {'name': name, 'gid': group_id})
            if result.rowcount == 0:
                raise HTTPException(404, "Chant group not found")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return {'chant_group_id': group_id, 'canonical_name': name}


def _compute_candidates(conn) -> list:
    """Return sorted list of (group_a, group_b, sim, mode, part) not yet reviewed."""
    group_rows = conn.execute(text("""
        SELECT
            cg.chant_group_id,
            cg.canonical_name,
            cg.incipit,
            (
                SELECT gc.mode
                FROM gregobase_chant_group_map m
                JOIN gregobase_chants gc ON gc.id = m.gregobase_id
                WHERE m.chant_group_id = cg.chant_group_id
                  AND gc.mode IS NOT NULL AND gc.mode != ''
                ORDER BY gc.id LIMIT 1
            ) AS mode,
            (
                SELECT gc.`office-part`
                FROM gregobase_chant_group_map m
                JOIN gregobase_chants gc ON gc.id = m.gregobase_id
                WHERE m.chant_group_id = cg.chant_group_id
                  AND gc.`office-part` IS NOT NULL AND gc.`office-part` != ''
                ORDER BY gc.id LIMIT 1
            ) AS office_part
        FROM chant_group cg
        WHERE cg.incipit IS NOT NULL AND cg.incipit != ''
    """)).mappings().fetchall()

    reviewed = {
        (int(r[0]), int(r[1]))
        for r in conn.execute(text(
            "SELECT group_id_a, group_id_b FROM chant_group_merge_queue"
        )).fetchall()
    }

    buckets: dict = {}
    for g in group_rows:
        mode = (g['mode'] or '').strip() or None
        part = PART_NORMALIZE.get((g['office_part'] or '').lower()) if g['office_part'] else None
        if mode is None or part is None:
            continue
        buckets.setdefault((mode, part), []).append(dict(g))

    candidates = []
    for (mode, part), bucket in buckets.items():
        if len(bucket) < 2:
            continue
        bucket.sort(key=lambda g: _clean_incipit(g['incipit'] or ''))
        for i in range(len(bucket) - 1):
            for j in range(i + 1, min(i + 4, len(bucket))):
                a, b = bucket[i], bucket[j]
                pair_key = (
                    min(a['chant_group_id'], b['chant_group_id']),
                    max(a['chant_group_id'], b['chant_group_id']),
                )
                if pair_key in reviewed:
                    continue
                ci_a = _clean_incipit(a['incipit'] or '')
                ci_b = _clean_incipit(b['incipit'] or '')
                if not ci_a or not ci_b:
                    continue
                sim = SequenceMatcher(None, ci_a, ci_b).ratio()
                if sim >= _MERGE_SIM_THRESHOLD:
                    candidates.append((a, b, sim, mode, part))

    candidates.sort(key=lambda x: (-x[2], x[0]['chant_group_id']))
    return candidates


@app.get("/api/merge-queue/count")
def get_merge_queue_count():
    try:
        with ro().connect() as conn:
            return {'count': len(_compute_candidates(conn))}
    except Exception as exc:
        raise HTTPException(503, str(exc))


@app.get("/api/merge-queue/candidates", response_model=List[MergeQueuePair])
def get_merge_queue_candidates(
    limit: int = Query(20, le=100),
    offset: int = 0,
):
    try:
        with ro().connect() as conn:
            candidates = _compute_candidates(conn)
    except Exception as exc:
        raise HTTPException(503, str(exc))

    page = candidates[offset: offset + limit]
    if not page:
        return []

    # Batch-fetch representative GABCs and chant counts for the needed group IDs
    needed_ids = list({gid for a, b, *_ in page for gid in (a['chant_group_id'], b['chant_group_id'])})
    id_ph     = ', '.join(f':g{i}' for i in range(len(needed_ids)))
    id_params = {f'g{i}': gid for i, gid in enumerate(needed_ids)}

    try:
        with ro().connect() as conn:
            rep_rows = conn.execute(text(f"""
                SELECT m.chant_group_id, gc.incipit AS rep_incipit, gc.gabc AS rep_gabc
                FROM gregobase_chant_group_map m
                JOIN gregobase_chants gc ON gc.id = m.gregobase_id
                WHERE m.chant_group_id IN ({id_ph}) AND gc.gabc IS NOT NULL
                ORDER BY m.chant_group_id, gc.id
            """), id_params).mappings().fetchall()
            rep_map: dict = {}
            for r in rep_rows:
                gid = r['chant_group_id']
                if gid not in rep_map:
                    rep_map[gid] = r

            gb_cnt = {r[0]: r[1] for r in conn.execute(text(f"""
                SELECT chant_group_id, COUNT(*) FROM gregobase_chant_group_map
                WHERE chant_group_id IN ({id_ph}) GROUP BY chant_group_id
            """), id_params).fetchall()}
            lc_cnt = {r[0]: r[1] for r in conn.execute(text(f"""
                SELECT chant_group_id, COUNT(*) FROM local_chants
                WHERE chant_group_id IN ({id_ph}) GROUP BY chant_group_id
            """), id_params).fetchall()}
    except Exception as exc:
        raise HTTPException(503, str(exc))

    def make_summary(g, mode, part) -> ChantGroupSummary:
        gid = g['chant_group_id']
        rep = rep_map.get(gid)
        inc = g['incipit'] or ''
        return ChantGroupSummary(
            chant_group_id=gid,
            canonical_name=g['canonical_name'],
            incipit=inc,
            incipit_clean=_clean_incipit(inc) if inc else None,
            mode=mode,
            office_part=part,
            rep_incipit=rep['rep_incipit'] if rep else None,
            rep_gabc_body=extract_gabc_body(rep['rep_gabc'] or '') if rep else None,
            chant_count=gb_cnt.get(gid, 0) + lc_cnt.get(gid, 0),
        )

    return [
        MergeQueuePair(
            group_a=make_summary(a, mode, part),
            group_b=make_summary(b, mode, part),
            similarity=round(sim, 3),
        )
        for a, b, sim, mode, part in page
    ]


@app.post("/api/merge-queue/merge")
def merge_chant_groups(body: MergeRequest):
    keep_id  = body.keep_id
    merge_id = body.merge_id
    if keep_id == merge_id:
        raise HTTPException(400, "keep_id and merge_id must be different")
    try:
        with rw().begin() as conn:
            if not conn.execute(text(
                "SELECT 1 FROM chant_group WHERE chant_group_id = :gid"
            ), {'gid': keep_id}).fetchone():
                raise HTTPException(404, f"Chant group {keep_id} not found")
            if not conn.execute(text(
                "SELECT 1 FROM chant_group WHERE chant_group_id = :gid"
            ), {'gid': merge_id}).fetchone():
                raise HTTPException(404, f"Chant group {merge_id} not found")

            # Gregobase map entries already in keep group → delete before remapping
            dup_rows = conn.execute(text("""
                SELECT m.gregobase_id
                FROM gregobase_chant_group_map m
                JOIN gregobase_chant_group_map k
                  ON k.gregobase_id = m.gregobase_id AND k.chant_group_id = :keep_id
                WHERE m.chant_group_id = :merge_id
            """), {'keep_id': keep_id, 'merge_id': merge_id}).fetchall()
            dup_ids = [r[0] for r in dup_rows]

            if dup_ids:
                dup_ph = ', '.join(f':d{i}' for i in range(len(dup_ids)))
                dup_params = {f'd{i}': gid for i, gid in enumerate(dup_ids)}
                dup_params['merge_id'] = merge_id
                conn.execute(text(f"""
                    DELETE FROM gregobase_chant_group_map
                    WHERE chant_group_id = :merge_id AND gregobase_id IN ({dup_ph})
                """), dup_params)

            conn.execute(text("""
                UPDATE gregobase_chant_group_map
                SET chant_group_id = :keep_id WHERE chant_group_id = :merge_id
            """), {'keep_id': keep_id, 'merge_id': merge_id})
            conn.execute(text("""
                UPDATE local_chants
                SET chant_group_id = :keep_id WHERE chant_group_id = :merge_id
            """), {'keep_id': keep_id, 'merge_id': merge_id})
            # lit_part_sources uses chant_uuid (not chant_group_id), so no update
            # needed here — the gregobase_chant_group_map and local_chants updates
            # above are sufficient for the JOIN-derived chant_group_id to resolve correctly.
            conn.execute(text(
                "DELETE FROM chant_group WHERE chant_group_id = :merge_id"
            ), {'merge_id': merge_id})

            pair_a = min(keep_id, merge_id)
            pair_b = max(keep_id, merge_id)
            conn.execute(text("""
                INSERT INTO chant_group_merge_queue
                    (group_id_a, group_id_b, status, merged_into_id, reviewed_at)
                VALUES (:a, :b, 'merged', :keep_id, NOW())
                ON DUPLICATE KEY UPDATE
                    status = 'merged', merged_into_id = :keep_id, reviewed_at = NOW()
            """), {'a': pair_a, 'b': pair_b, 'keep_id': keep_id})
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return {'merged_into': keep_id}


@app.post("/api/merge-queue/reject")
def reject_merge_pair(body: RejectRequest):
    a = min(body.group_id_a, body.group_id_b)
    b = max(body.group_id_a, body.group_id_b)
    if a == b:
        raise HTTPException(400, "group_id_a and group_id_b must be different")
    try:
        with rw().begin() as conn:
            conn.execute(text("""
                INSERT INTO chant_group_merge_queue
                    (group_id_a, group_id_b, status, merged_into_id, reviewed_at)
                VALUES (:a, :b, 'rejected', NULL, NOW())
                ON DUPLICATE KEY UPDATE
                    status = 'rejected', merged_into_id = NULL, reviewed_at = NOW()
            """), {'a': a, 'b': b})
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return {'ok': True}


@app.post("/api/merge-queue/related")
def mark_merge_pair_related(body: RejectRequest):
    a = min(body.group_id_a, body.group_id_b)
    b = max(body.group_id_a, body.group_id_b)
    if a == b:
        raise HTTPException(400, "group_id_a and group_id_b must be different")
    try:
        with rw().begin() as conn:
            conn.execute(text("""
                INSERT INTO chant_group_merge_queue
                    (group_id_a, group_id_b, status, merged_into_id, reviewed_at)
                VALUES (:a, :b, 'related', NULL, NOW())
                ON DUPLICATE KEY UPDATE
                    status = 'related', merged_into_id = NULL, reviewed_at = NOW()
            """), {'a': a, 'b': b})
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return {'ok': True}


# ── Static / SPA ──────────────────────────────────────────────────────────────
import os
_STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

@app.get("/")
def root():
    return FileResponse(os.path.join(_STATIC_DIR, "index.html"))

@app.get("/sources")
def sources_page():
    return FileResponse(os.path.join(_STATIC_DIR, "sources.html"))

@app.get("/assignments")
def assignments_page():
    return FileResponse(os.path.join(_STATIC_DIR, "assignments.html"))

@app.get("/mergers")
def mergers_page():
    return FileResponse(os.path.join(_STATIC_DIR, "mergers.html"))

app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")
