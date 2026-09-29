from typing import Optional, List
import datetime
import re
import uuid
import unicodedata
from difflib import SequenceMatcher
import keyring
from sqlalchemy import create_engine, text
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, computed_field, model_validator

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
    cycle_sun: Optional[int] = None
    cycle_wkday: Optional[int] = None
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
    cycle_sun: Optional[int] = None
    cycle_wkday: Optional[int] = None
    option_num: int = 1
    notes: Optional[str] = None

    @model_validator(mode='after')
    def _check_cycle_exclusivity(self):
        if self.cycle_sun is not None and self.cycle_wkday is not None:
            raise ValueError("at most one of cycle_sun and cycle_wkday may be set")
        return self


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
    printed_page_num: Optional[str] = None
    ref_page_num: Optional[int] = None
    ref_printed_page_num: Optional[str] = None
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

    @computed_field
    @property
    def cycle(self) -> Optional[str]:
        if self.cycle_sun is not None and self.cycle_wkday is not None:
            return None
        if self.cycle_sun is not None:
            return ('C', 'A', 'B')[self.cycle_sun % 3]
        if self.cycle_wkday is not None:
            return ('II', 'I')[self.cycle_wkday % 2]
        return None


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

    @model_validator(mode='after')
    def _check_cycle_exclusivity(self):
        if self.cycle_sun is not None and self.cycle_wkday is not None:
            raise ValueError("at most one of cycle_sun and cycle_wkday may be set")
        return self


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
        conditions.append(f"LOWER(lc.office_part) IN ({placeholders})")
        for i, v in enumerate(equiv):
            params[f'p{i}'] = v

    where = ('WHERE ' + ' AND '.join(conditions)) if conditions else ''

    sql = text(f"""
        SELECT lc.local_chant_id, lc.chant_group_id, lc.version, lc.incipit,
               lc.office_part AS part, lc.mode, lc.status,
               lc.translation_source_code, lc.is_text_exact,
               cg.canonical_name
        FROM local_chants lc
        JOIN chant_group cg ON cg.chant_group_id = lc.chant_group_id
        {where}
        ORDER BY cg.canonical_name, lc.office_part, lc.version
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
                       lc.office_part AS part, lc.mode, lc.status,
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
                SELECT translation_source_code, display_name, short_code
                FROM p_translation_source
                WHERE is_active = 1
                ORDER BY sort_order
            """)).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))

    return [
        {'code': r['translation_source_code'], 'display_name': r['display_name'], 'short_code': r['short_code']}
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


# ── Day view: observances + chant parts for a civil date ───────────────────────
# Deliberately does NOT run full liturgical precedence (see resolver.py) — it
# surfaces every observance that COULD apply to the date (the temporal day,
# any saint whose fixed nominal date matches, plus anything the calendar
# resolver has materialized for the date, e.g. a transferred-in solemnity) and
# lets the caller/UI decide what to do with more than one. This also means the
# page works outside the resolver's currently-materialized 2027-2028 window.

class DayPartAssignment(BaseModel):
    service_code: str
    part_code: str
    display_name: str
    display_order: int
    option_num: int = 1
    text_id: Optional[int] = None
    chant_uuid: Optional[str] = None
    chant_group_id: Optional[int] = None
    assignment_authority_code: Optional[str] = None
    assignment_jurisdiction: Optional[str] = None
    notes: Optional[str] = None


class DayFormulary(BaseModel):
    # A day can have more than one Mass formulary hanging off it as `kind='mass'`
    # children in lit_epoch_tree (e.g. Christmas: Vigil / Night / Dawn / Day).
    # `title` is None for the common case of a single, unnamed formulary — the
    # observance's own title already says everything the UI needs to show.
    epoch_slug: str
    title: Optional[str] = None
    services: dict[str, List[DayPartAssignment]]


class DayObservance(BaseModel):
    epoch_slug: str
    title: str
    kind: str
    rank_code: Optional[str] = None
    rank_display_name: Optional[str] = None
    role: Optional[str] = None            # celebrated / commemoration / optional / None (unresolved)
    is_transferred: bool = False
    nominal_dt: Optional[str] = None
    formularies: List[DayFormulary]


class DayResponse(BaseModel):
    date: str
    jurisdiction: str
    observances: List[DayObservance]


_DAY_PARTS_SQL = """
    WITH RECURSIVE ancestors AS (
        SELECT :epoch_slug AS slug, 0 AS depth
        UNION ALL
        SELECT et.parent_slug, a.depth + 1
        FROM ancestors a JOIN lit_epoch_tree et ON et.child_slug = a.slug
    ),
    candidates AS (
        SELECT
            sp.service_code, sp.part_code, sp.display_name, sp.display_order,
            lps.part_id, lps.text_id, lps.option_num,
            lps.jurisdiction                AS assignment_jurisdiction,
            lps.assignment_authority_code, lps.notes, lps.chant_uuid,
            COALESCE(gcm.chant_group_id, lc.chant_group_id) AS chant_group_id,
            CASE WHEN lps.lit_epoch_slug IS NOT NULL THEN 1 ELSE 0 END AS epoch_match,
            anc.depth,
            (   (lps.cycle_wkday IS NOT NULL) +
                (lps.cycle_sun   IS NOT NULL) +
                (lps.wkday       IS NOT NULL)
            ) AS cycle_specificity,
            CASE WHEN lps.jurisdiction = :jurisdiction THEN 1 ELSE 0 END AS jur_preference
        FROM service_part sp
        JOIN lit_part_sources lps
          ON lps.part_id = sp.part_id
         AND lps.jurisdiction IN (:jurisdiction, 'UNIVERSAL')
        LEFT JOIN ancestors anc
          ON anc.slug = lps.lit_epoch_slug
        LEFT JOIN gregobase_chant_group_map gcm
               ON lps.chant_uuid LIKE 'gregobase:%'
              AND gcm.gregobase_id = CAST(SUBSTRING(lps.chant_uuid, 11) AS UNSIGNED)
        LEFT JOIN local_chants lc
               ON lps.chant_uuid LIKE 'local:%'
              AND lc.local_chant_id = SUBSTRING(lps.chant_uuid, 7)
        WHERE (
            (lps.lit_epoch_slug IS NOT NULL AND anc.slug IS NOT NULL)
            OR (
                lps.lit_epoch_slug IS NULL
                AND (lps.wknum_mod_4 IS NULL OR lps.wknum_mod_4 = MOD(:wknum, 4))
                AND (lps.wknum_mod_2 IS NULL OR lps.wknum_mod_2 = MOD(:wknum, 2))
            )
        )
        AND (lps.cycle_wkday IS NULL OR lps.cycle_wkday = :cycle_wk)
        AND (lps.cycle_sun   IS NULL OR lps.cycle_sun   = :cycle_sun)
        AND (lps.wkday       IS NULL OR lps.wkday       = :wkday)
    ),
    ranked AS (
        SELECT c.*,
            ROW_NUMBER() OVER (
                PARTITION BY c.part_id
                ORDER BY
                    c.epoch_match       DESC,
                    c.depth             ASC,
                    c.cycle_specificity DESC,
                    c.jur_preference    DESC,
                    c.text_id           DESC
            ) AS rn
        FROM candidates c
    )
    SELECT service_code, part_code, display_name, display_order, option_num,
           text_id, chant_uuid, chant_group_id,
           assignment_authority_code, assignment_jurisdiction, notes
    FROM ranked
    WHERE rn = 1
    ORDER BY service_code, display_order
"""


def _day_parts_for_epoch(conn, jurisdiction: str, epoch_slug: str, ctx: dict) -> dict:
    """Return {service_code: [DayPartAssignment, ...]} for one epoch slug."""
    rows = conn.execute(text(_DAY_PARTS_SQL), {
        'epoch_slug': epoch_slug,
        'jurisdiction': jurisdiction,
        'cycle_wk': ctx['cycle_wk'],
        'cycle_sun': ctx['cycle_sun'],
        'wkday': ctx['wkday'],
        'wknum': ctx['wknum'],
    }).mappings().fetchall()

    services: dict = {}
    for r in rows:
        services.setdefault(r['service_code'], []).append(DayPartAssignment(**dict(r)))
    return services


def _child_mass_epochs(conn, epoch_slug: str) -> list:
    """Return [{'slug', 'title'}, ...] for kind='mass' children of epoch_slug.

    A day can print more than one Mass formulary (e.g. Christmas: Vigil /
    Night / Dawn / Day Masses), each modeled as its own lit_epoch_tree child
    of kind='mass' rather than as direct lit_part_sources rows on the day
    itself — those rows hang off the child slugs instead.
    """
    rows = conn.execute(text("""
        SELECT et.child_slug AS slug, le.title
        FROM lit_epoch_tree et
        JOIN lit_epoch le ON le.slug = et.child_slug
        WHERE et.parent_slug = :slug AND le.kind = 'mass'
        ORDER BY le.seq, le.sort_order, le.slug
    """), {'slug': epoch_slug}).mappings().fetchall()
    return [{'slug': r['slug'], 'title': r['title']} for r in rows]


def _formularies_for_epoch(conn, jurisdiction: str, epoch_slug: str, ctx: dict) -> List[DayFormulary]:
    """Build the list of Mass (etc.) formularies for one observance.

    Most days have exactly one, unnamed formulary carrying the direct
    assignments on the observance's own slug. Days with kind='mass' children
    (multiple Masses for one day) get one named formulary per child instead;
    the direct assignments on the day slug itself are prepended too, in the
    rare case a day carries both.
    """
    direct_services = _day_parts_for_epoch(conn, jurisdiction, epoch_slug, ctx)
    children = _child_mass_epochs(conn, epoch_slug)

    if not children:
        return [DayFormulary(epoch_slug=epoch_slug, title=None, services=direct_services)]

    formularies = []
    if direct_services:
        formularies.append(DayFormulary(epoch_slug=epoch_slug, title=None, services=direct_services))
    for child in children:
        child_services = _day_parts_for_epoch(conn, jurisdiction, child['slug'], ctx)
        if child_services:
            formularies.append(DayFormulary(
                epoch_slug=child['slug'], title=child['title'], services=child_services,
            ))
    if not formularies:
        # Children exist but none resolved any parts (e.g. data not loaded yet) —
        # fall back to a single empty formulary so the UI has something to show.
        formularies.append(DayFormulary(epoch_slug=epoch_slug, title=None, services={}))
    return formularies


@app.get("/api/day/{date}", response_model=DayResponse)
def get_day(date: str, jurisdiction: str = Query('US')):
    try:
        dt = datetime.date.fromisoformat(date)
    except ValueError:
        raise HTTPException(400, "date must be YYYY-MM-DD")

    try:
        with ro().connect() as conn:
            temporal = conn.execute(text("""
                SELECT pos.lit_day_id AS epoch_slug, le.title, le.kind, le.rank_code,
                       plr.display_name AS rank_display_name, plr.sort_order AS rank_sort,
                       pos.cycle_wk, pos.cycle_sun, pos.wkday, le.wknum
                FROM proper_of_seasons pos
                JOIN lit_epoch le  ON le.slug        = pos.lit_day_id
                JOIN p_lit_rank plr ON plr.rank_code = le.rank_code
                WHERE pos.dt = :dt
                  AND pos.jurisdiction IN (:jur, 'UNIVERSAL')
                ORDER BY CASE WHEN pos.jurisdiction = :jur THEN 0 ELSE 1 END
                LIMIT 1
            """), {'dt': dt, 'jur': jurisdiction}).mappings().fetchone()

            if not temporal:
                raise HTTPException(404, f"No liturgical calendar data for {date}")

            ctx = {
                'cycle_wk': temporal['cycle_wk'],
                'cycle_sun': temporal['cycle_sun'],
                'wkday': temporal['wkday'],
                'wknum': temporal['wknum'],
            }

            observances: dict = {
                temporal['epoch_slug']: {
                    'epoch_slug': temporal['epoch_slug'],
                    'title': temporal['title'] or temporal['epoch_slug'],
                    'kind': temporal['kind'],
                    'rank_code': temporal['rank_code'],
                    'rank_display_name': temporal['rank_display_name'],
                    'role': 'celebrated',
                    'is_transferred': False,
                    'nominal_dt': None,
                    '_rank_sort': temporal['rank_sort'],
                }
            }

            # Any saint whose fixed nominal date is this civil date, regardless
            # of whether it would actually be celebrated (no precedence run here).
            saint_rows = conn.execute(text("""
                SELECT pos.slug AS epoch_slug, le.title, le.kind, le.rank_code,
                       plr.display_name AS rank_display_name, plr.sort_order AS rank_sort,
                       pos.jurisdiction
                FROM proper_of_saints pos
                JOIN lit_epoch le   ON le.slug        = pos.slug
                JOIN p_lit_rank plr ON plr.rank_code = pos.rank_code
                WHERE pos.month_nominal = :m AND pos.day_nominal = :d
                  AND pos.jurisdiction IN (:jur, 'UNIVERSAL')
                ORDER BY CASE WHEN pos.jurisdiction = :jur THEN 0 ELSE 1 END
            """), {'m': dt.month, 'd': dt.day, 'jur': jurisdiction}).mappings().fetchall()

            for r in saint_rows:
                if r['epoch_slug'] in observances:
                    continue
                observances[r['epoch_slug']] = {
                    'epoch_slug': r['epoch_slug'],
                    'title': r['title'] or r['epoch_slug'],
                    'kind': r['kind'],
                    'rank_code': r['rank_code'],
                    'rank_display_name': r['rank_display_name'],
                    'role': None,
                    'is_transferred': False,
                    'nominal_dt': None,
                    '_rank_sort': r['rank_sort'],
                }

            # Overlay the materialized resolver, when available for this date:
            # confirms/annotates role + transfer info, and surfaces any
            # observance transferred onto this date from elsewhere.
            resolver_rows = conn.execute(text("""
                SELECT r.epoch_slug, r.role, r.is_transferred, r.nominal_dt,
                       le.title, le.kind, le.rank_code,
                       plr.display_name AS rank_display_name, plr.sort_order AS rank_sort
                FROM lit_observance_resolved r
                JOIN lit_epoch le   ON le.slug        = r.epoch_slug
                JOIN p_lit_rank plr ON plr.rank_code = le.rank_code
                WHERE r.dt = :dt AND r.jurisdiction IN (:jur, 'UNIVERSAL')
                  AND r.role != 'omitted'
                ORDER BY CASE WHEN r.jurisdiction = :jur THEN 0 ELSE 1 END
            """), {'dt': dt, 'jur': jurisdiction}).mappings().fetchall()

            seen = set()
            for r in resolver_rows:
                slug = r['epoch_slug']
                if slug in seen:
                    continue
                seen.add(slug)
                nominal = r['nominal_dt'].isoformat() if r['nominal_dt'] else None
                if slug in observances:
                    observances[slug]['role'] = r['role']
                    observances[slug]['is_transferred'] = bool(r['is_transferred'])
                    observances[slug]['nominal_dt'] = nominal
                else:
                    observances[slug] = {
                        'epoch_slug': slug,
                        'title': r['title'] or slug,
                        'kind': r['kind'],
                        'rank_code': r['rank_code'],
                        'rank_display_name': r['rank_display_name'],
                        'role': r['role'],
                        'is_transferred': bool(r['is_transferred']),
                        'nominal_dt': nominal,
                        '_rank_sort': r['rank_sort'],
                    }

            result = []
            sort_keys = []
            for obs in observances.values():
                obs['formularies'] = _formularies_for_epoch(conn, jurisdiction, obs['epoch_slug'], ctx)
                sort_keys.append(obs.pop('_rank_sort', 9999))
                result.append(DayObservance(**obs))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))

    # Most important (lowest p_lit_rank.sort_order) first.
    result = [o for _, o in sorted(zip(sort_keys, result), key=lambda p: p[0])]

    return DayResponse(date=date, jurisdiction=jurisdiction, observances=result)


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
           lps.book, b.printed_page_num,
           lps.ref_page_num, b2.printed_page_num AS ref_printed_page_num,
           lps.bbox, lps.chant_uuid
    FROM lit_part_sources lps
    JOIN service_part sp ON sp.part_id = lps.part_id
    LEFT JOIN lit_epoch le ON le.slug = lps.lit_epoch_slug
    LEFT JOIN books b  ON b.book  = lps.book AND b.printed_page_num = lps.printed_page_num
    LEFT JOIN books b2 ON b2.book = lps.book AND b2.printed_page_num = lps.ref_page_num
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
        printed_page_num=r['printed_page_num'],
        ref_page_num=r['ref_page_num'],
        ref_printed_page_num=r['ref_printed_page_num'],
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
        conditions.append("lps.book IS NOT NULL AND lps.printed_page_num IS NOT NULL")
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
        ORDER BY lps.book,
                 CAST(lps.printed_page_num AS UNSIGNED), lps.printed_page_num,
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


@app.get("/api/lit_part_sources/books", response_model=List[str])
def list_lps_books():
    sql = text(
        "SELECT DISTINCT book FROM lit_part_sources"
        " WHERE book IS NOT NULL ORDER BY book"
    )
    try:
        with ro().connect() as conn:
            rows = conn.execute(sql).fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return [r[0] for r in rows]


class SimilarTextResult(BaseModel):
    score: float
    text_id: int
    option_num: Optional[int] = None
    original_text: Optional[str] = None
    vernacular_text: Optional[str] = None
    text_src: Optional[str] = None
    lit_epoch_slug: Optional[str] = None
    epoch_title: Optional[str] = None
    part_code: Optional[str] = None
    part_name: Optional[str] = None
    translation_source_code: Optional[str] = None
    translation_short_code: Optional[str] = None
    translation_display_name: Optional[str] = None
    text_page_num: Optional[str] = None      # stringified like CompositionText
    book: Optional[str] = None
    printed_page_num: Optional[str] = None   # src page, stringified
    bbox: Optional[str] = None
    review_status: Optional[str] = None


_LATIN_ORTHO = str.maketrans({'æ': 'ae', 'œ': 'oe', 'j': 'i', 'v': 'u'})


def _norm_latin(s: str) -> str:
    """Normalize Latin text for fuzzy comparison: lowercase, strip accents,
    fold classical/liturgical orthography variants (æ/œ, j/v vs i/u), keep
    only letters and spaces, collapse whitespace."""
    s = s.lower()
    s = unicodedata.normalize('NFKD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = s.translate(_LATIN_ORTHO)
    s = re.sub(r'[^a-z ]', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def _partial_ratio(a: str, b: str) -> float:
    """Best ratio of the shorter string against any same-length window of the longer."""
    if len(a) > len(b):
        a, b = b, a
    if not a:
        return 0.0
    best = 0.0
    for i, j, _n in SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
        start = max(0, j - i)
        best = max(best, SequenceMatcher(None, a, b[start:start + len(a)], autojunk=False).ratio())
    return best


@app.get("/api/lit_part_sources/similar", response_model=List[SimilarTextResult])
def similar_lit_part_sources(
    q: str = Query(..., max_length=2000),
    limit: int = Query(30, ge=1, le=100),
):
    norm_q = _norm_latin(q)
    if len(norm_q) < 3:
        raise HTTPException(400, "q is too short after normalization")
    q_tokens = set(norm_q.split())

    sql = text("""
        SELECT lps.text_id, lps.option_num,
               COALESCE(lps.original_text, gct.text) AS original_text,
               lps.vernacular_text, lps.text_src,
               lps.lit_epoch_slug, le.title AS epoch_title,
               sp.part_code, sp.display_name AS part_name,
               lps.translation_source_code,
               pts.short_code AS translation_short_code, pts.display_name AS translation_display_name,
               COALESCE(lps.ref_page_num, lps.printed_page_num) AS text_page_num,
               lps.book, lps.printed_page_num AS src_page_num,
               lps.bbox, lps.review_status
        FROM lit_part_sources lps
        JOIN service_part sp ON sp.part_id = lps.part_id
        LEFT JOIN lit_epoch le ON le.slug = lps.lit_epoch_slug
        LEFT JOIN gregobase_chants_texts gct ON lps.chant_uuid = CONCAT('gregobase:', gct.id)
        LEFT JOIN p_translation_source pts ON pts.translation_source_code = lps.translation_source_code
        WHERE lps.vernacular_text IS NOT NULL
    """)
    try:
        with ro().connect() as conn:
            rows = conn.execute(sql).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))

    candidates = []
    for r in rows:
        norm_cand = _norm_latin(r['original_text'] or '')
        if not norm_cand:
            continue
        if len(q_tokens) >= 2:
            cand_tokens = set(norm_cand.split())
            union = q_tokens | cand_tokens
            jaccard = len(q_tokens & cand_tokens) / len(union) if union else 0.0
            if jaccard == 0:
                continue
        else:
            jaccard = 0.0
        candidates.append((jaccard, norm_cand, r))

    candidates.sort(key=lambda t: t[0], reverse=True)
    candidates = candidates[:300]

    scored = []
    for _, norm_cand, r in candidates:
        full = SequenceMatcher(None, norm_q, norm_cand, autojunk=False).ratio()
        score = 0.65 * _partial_ratio(norm_q, norm_cand) + 0.35 * full
        scored.append((score, r))
    scored.sort(key=lambda t: (-t[0], t[1]['text_id']))

    results = []
    for score, r in scored[:limit]:
        results.append(SimilarTextResult(
            score=round(score, 3),
            text_id=r['text_id'],
            option_num=r['option_num'],
            original_text=r['original_text'],
            vernacular_text=r['vernacular_text'],
            text_src=r['text_src'],
            lit_epoch_slug=r['lit_epoch_slug'],
            epoch_title=r['epoch_title'],
            part_code=r['part_code'],
            part_name=r['part_name'],
            translation_source_code=r['translation_source_code'],
            translation_short_code=r['translation_short_code'],
            translation_display_name=r['translation_display_name'],
            text_page_num=str(r['text_page_num']) if r['text_page_num'] is not None else None,
            book=r['book'],
            printed_page_num=str(r['src_page_num']) if r['src_page_num'] is not None else None,
            bbox=r['bbox'],
            review_status=r['review_status'],
        ))
    return results


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
    if 'cycle_sun' in fields or 'cycle_wkday' in fields:
        try:
            with ro().connect() as conn:
                cur = conn.execute(
                    text("SELECT cycle_sun, cycle_wkday FROM lit_part_sources WHERE text_id = :tid"),
                    {'tid': text_id},
                ).mappings().fetchone()
        except Exception as exc:
            raise HTTPException(503, str(exc))
        if not cur:
            raise HTTPException(404, "Assignment not found")
        if (fields.get('cycle_sun', cur['cycle_sun']) is not None
                and fields.get('cycle_wkday', cur['cycle_wkday']) is not None):
            raise HTTPException(422, "at most one of cycle_sun and cycle_wkday may be set")
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


# Graduale chapters 4–5 — the ritual, votive, ad-diversa and funeral formularies —
# are lit_epoch kind='ritual'. Unlike every other kind they carry no sort_order, no
# season and no lit_epoch_tree edge, so neither book order nor the chapter a
# formulary belongs to can be read off lit_epoch. Both are derived here from the
# printed GRADUALE page its own lit_part_sources rows sit on. This is display-only
# grouping for the Assignment Review sidebar; nothing in the data model depends on
# it. The durable fix would be container nodes + tree edges, as kind='common' has.
_RITUAL_CHAPTERS = (
    (643, 649, 'rituales',    'Ritual Masses'),
    (650, 657, 'ad-diversa',  'Masses for Various Needs'),
    (658, 666, 'votivae',     'Votive Masses'),
    (667, 999, 'defunctorum', 'Masses for the Dead'),
)

# MIN() is scoped to the Graduale because page numbering is per-book: a formulary
# with Gregorian Missal rows too (missa-pro-defunctis, ordo-exsequiarum) would
# otherwise mix two numbering spaces.
_GR_PAGE_JOIN = """
    LEFT JOIN (
        SELECT lit_epoch_slug, MIN(CAST(printed_page_num AS UNSIGNED)) AS gr_page
        FROM lit_part_sources
        WHERE book = 'GRADUALE' AND printed_page_num IS NOT NULL
        GROUP BY lit_epoch_slug
    ) pg ON pg.lit_epoch_slug = le.slug
"""


def _ritual_chapter(gr_page: Optional[int]) -> tuple:
    if gr_page is not None:
        for lo, hi, code, label in _RITUAL_CHAPTERS:
            if lo <= gr_page <= hi:
                return code, label
    return 'other', 'Other'


@app.get("/api/lit_epochs")
def list_lit_epochs(
    kind: Optional[str] = None,
    season: Optional[str] = None,
    subseason: Optional[str] = None,
    wknum: Optional[str] = None,
    month: Optional[int] = None,
):
    conditions = []
    params: dict = {}
    if kind:
        conditions.append("le.kind = :kind")
        params['kind'] = kind
    if season:
        conditions.append("le.season = :season")
        params['season'] = season
    if subseason:
        conditions.append("le.subseason = :subseason")
        params['subseason'] = subseason
    if wknum:
        conditions.append("le.wknum = :wknum")
        params['wknum'] = wknum

    # Saint nodes carry no date of their own; join proper_of_saints for
    # month_nominal/day_nominal so the Assignment Review "Saint" browse mode
    # can sort by date, group by month, and filter to a single month.
    saint_mode = kind == 'saint'
    if saint_mode and month:
        conditions.append("ps.month_nominal = :month")
        params['month'] = month

    where = ('WHERE ' + ' AND '.join(conditions)) if conditions else ''

    base_cols = "le.slug, le.kind, le.title, le.season, le.subseason, le.wknum, le.sort_order"

    if kind == 'ritual':
        # sort_order is NULL on every ritual row, so fall back to book order.
        # Two formularies starting on the same page tie-break on slug — where
        # they sit on the page is not recoverable from lit_part_sources.
        select_cols = base_cols + ", pg.gr_page"
        join_clause = _GR_PAGE_JOIN
        order_clause = "ORDER BY (pg.gr_page IS NULL), pg.gr_page, le.slug"
    elif kind == 'common':
        # The Commons nest one level deep (5 containers over 17 formularies);
        # parent_slug lets the sidebar indent children under their container.
        select_cols = base_cols + ", tr.parent_slug"
        join_clause = """
            LEFT JOIN (
                SELECT child_slug, MIN(parent_slug) AS parent_slug
                FROM lit_epoch_tree GROUP BY child_slug
            ) tr ON tr.child_slug = le.slug
        """
        order_clause = "ORDER BY le.sort_order, le.slug"
    elif saint_mode:
        select_cols = base_cols + ", ps.month_nominal, ps.day_nominal"
        join_clause = """
            LEFT JOIN (
                SELECT slug, month_nominal, day_nominal FROM (
                    SELECT slug, month_nominal, day_nominal,
                           ROW_NUMBER() OVER (
                               PARTITION BY slug
                               ORDER BY (jurisdiction = 'UNIVERSAL') DESC, jurisdiction
                           ) AS rn
                    FROM proper_of_saints
                ) ranked WHERE rn = 1
            ) ps ON ps.slug = le.slug
        """
        order_clause = "ORDER BY (ps.month_nominal IS NULL), ps.month_nominal, ps.day_nominal, le.slug"
    else:
        select_cols = base_cols
        join_clause = ""
        order_clause = "ORDER BY le.sort_order, le.slug"

    try:
        with ro().connect() as conn:
            rows = conn.execute(text(f"""
                SELECT {select_cols}
                FROM lit_epoch le
                {join_clause}
                {where}
                {order_clause}
            """), params).mappings().fetchall()
            result = [dict(r) for r in rows]
            if kind == 'ritual':
                for r in result:
                    gr_page = int(r['gr_page']) if r['gr_page'] is not None else None
                    r['gr_page'] = gr_page
                    r['chapter'], r['chapter_label'] = _ritual_chapter(gr_page)
            if kind == 'week':
                # Some wknum groups (Ash Wednesday's days, Holy Week, the O
                # Antiphons, Christmas Day, Epiphany's octave days, the OT
                # solemnities after Trinity Sunday, ...) never got their own
                # kind='week' row because they aren't full canonical weeks.
                # Synthesize a stand-in week entry for those groups so they
                # stay selectable in week-scoped UI (e.g. the assignment
                # review day filter).
                extra_conditions = ["kind IN ('day', 'mass')"]
                extra_params: dict = {}
                if season:
                    extra_conditions.append("season = :season")
                    extra_params['season'] = season
                if subseason:
                    extra_conditions.append("subseason = :subseason")
                    extra_params['subseason'] = subseason
                if wknum:
                    extra_conditions.append("wknum = :wknum")
                    extra_params['wknum'] = wknum
                group_rows = conn.execute(text(f"""
                    SELECT season, subseason, wknum, MIN(sort_order) AS sort_order
                    FROM lit_epoch
                    WHERE {' AND '.join(extra_conditions)}
                    GROUP BY season, subseason, wknum
                """), extra_params).mappings().fetchall()
                existing = {(r['season'], r['subseason'], r['wknum']) for r in rows}
                for g in group_rows:
                    # Sanctorale vigil Masses (assumption-vigil, ...) sit outside
                    # the temporal grid entirely — no season/subseason/wknum, so
                    # no week slug can be synthesized for them.
                    if g['season'] is None or g['subseason'] is None or g['wknum'] is None:
                        continue
                    key = (g['season'], g['subseason'], g['wknum'])
                    if key in existing:
                        continue
                    result.append({
                        'slug': f"{g['season']}-{g['subseason']}-{g['wknum']:02d}",
                        'kind': 'week',
                        'title': None,
                        'season': g['season'],
                        'subseason': g['subseason'],
                        'wknum': g['wknum'],
                        'sort_order': g['sort_order'],
                    })
                result.sort(key=lambda r: (r['sort_order'], r['slug']))
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return result


@app.get("/api/lit_epochs/{slug}/assignments_review")
def lit_epoch_assignments_review(slug: str):
    try:
        with ro().connect() as conn:
            epoch, ancestor_rows, descendant_epochs = _epoch_hierarchy(conn, slug)
            if epoch is None:
                raise HTTPException(404, "Epoch not found")
            kind = epoch['kind']
            ancestor_slugs = [a['slug'] for a in ancestor_rows]

            # Fetch ancestor assignments
            ancestor_assignments: list = []
            if ancestor_slugs:
                in_ph = ', '.join(f':a{i}' for i in range(len(ancestor_slugs)))
                in_params = {f'a{i}': s for i, s in enumerate(ancestor_slugs)}
                anc_rows = conn.execute(text(f"""
                    {_LPS_ASSIGN_SELECT}
                    WHERE lps.lit_epoch_slug IN ({in_ph})
                      AND lps.chant_uuid IS NOT NULL
                    ORDER BY sp.display_order, lps.jurisdiction, lps.option_num
                """), in_params).mappings().fetchall()
                ancestor_assignments = [_lps_as_assign_from_row(r) for r in anc_rows]

            # Fetch this epoch's own assignments
            own_rows = conn.execute(text(f"""
                {_LPS_ASSIGN_SELECT}
                WHERE lps.lit_epoch_slug = :slug
                  AND lps.chant_uuid IS NOT NULL
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

            # descendant_epochs already computed by _epoch_hierarchy above, in
            # sort_order (approximates depth-first traversal)
            # 'saint' sits at the day level, not the season level: its only
            # descendant is a Vigil Mass, which should nest one step in.
            kind_order = {'season': 0, 'subseason': 1, 'week': 2, 'day': 3, 'mass': 3, 'saint': 2}
            selected_depth = kind_order.get(kind, 0)

            # Fetch descendant assignments grouped by epoch
            child_by_epoch: dict = {}
            if descendant_epochs:
                desc_slugs = [e['slug'] for e in descendant_epochs]
                in_ph2 = ', '.join(f':d{i}' for i in range(len(desc_slugs)))
                in_params2 = {f'd{i}': s for i, s in enumerate(desc_slugs)}
                child_rows = conn.execute(text(f"""
                    {_LPS_ASSIGN_SELECT}
                    WHERE lps.lit_epoch_slug IN ({in_ph2})
                      AND lps.chant_uuid IS NOT NULL
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


@app.get("/api/books/{book}/{printed_page_num}/image")
def get_book_page_image(book: str, printed_page_num: str):
    try:
        with ro().connect() as conn:
            row = conn.execute(text("""
                SELECT image_blob FROM books
                WHERE book = :book AND printed_page_num = :pg
            """), {'book': book, 'pg': printed_page_num}).fetchone()
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
                "SELECT COALESCE(office_part,'(none)'), COUNT(*) FROM local_chants GROUP BY office_part"
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


# ── GR Index review ───────────────────────────────────────────────────────────

SECTION_TO_PART_CODE = {
    'introitus': 'in', 'in': 'in',
    'graduale': 'gr', 'gr': 'gr',
    'alleluia': 'al', 'al': 'al',
    'tractus': 'tr', 'tr': 'tr',
    'offertorium': 'of', 'of': 'of',
    'communio': 'co', 'co': 'co',
    'antiphona': 'an', 'an': 'an',
    'hymnus': 'hy', 'hy': 'hy',
    'psalmus': 'ps', 'ps': 'ps',
    'sequentia': 'se', 'se': 'se',
}


class GrIndexEntry(BaseModel):
    row_id: int
    page: Optional[int] = None           # printed page number from GR index
    page_idx: Optional[int] = None
    section_type: Optional[str] = None
    mode: Optional[int] = None
    incipit: Optional[str] = None
    match_status: Optional[str] = None
    gregobase_id: Optional[int] = None
    local_chant_id: Optional[str] = None
    # Joined display fields (populated in detail view)
    gb_incipit: Optional[str] = None
    gb_gabc_body: Optional[str] = None
    lc_incipit: Optional[str] = None
    lc_gabc_body: Optional[str] = None


class GrIndexEntryUpdate(BaseModel):
    gregobase_id: Optional[int] = None
    local_chant_id: Optional[str] = None
    match_status: Optional[str] = None


class NewLocalChantRequest(BaseModel):
    gabc: str
    incipit: Optional[str] = None
    mode: Optional[str] = None
    version: Optional[str] = 'latin'
    canonical_name: Optional[str] = None


class LocalChantSummary(BaseModel):
    local_chant_id: str
    incipit: Optional[str] = None
    mode: Optional[str] = None
    version: Optional[str] = None
    gabc_body: str
    status: Optional[str] = None


class CompositionText(BaseModel):
    text_id: int
    option_num: Optional[int] = None
    original_text: Optional[str] = None
    vernacular_text: Optional[str] = None
    text_src: Optional[str] = None
    found_at_slug: str
    found_at_title: Optional[str] = None
    translation_source_code: Optional[str] = None
    translation_short_code: Optional[str] = None
    text_page_num: Optional[str] = None
    book: Optional[str] = None
    printed_page_num: Optional[str] = None
    bbox: Optional[str] = None
    review_status: Optional[str] = None


class CompositionChant(BaseModel):
    text_id: int
    option_num: Optional[int] = None
    chant_uuid: str
    gabc_body: str
    original_text: Optional[str] = None
    incipit: Optional[str] = None
    mode: Optional[str] = None
    version: Optional[str] = None
    found_at_slug: str
    found_at_title: Optional[str] = None
    book: Optional[str] = None
    printed_page_num: Optional[str] = None
    chant_page_num: Optional[str] = None
    bbox: Optional[str] = None
    text_src: Optional[str] = None
    translation_short_code: Optional[str] = None
    review_status: Optional[str] = None
    cycle_sun: Optional[int] = None
    cycle_wkday: Optional[int] = None
    wkday: Optional[int] = None

    @computed_field
    @property
    def cycle(self) -> Optional[str]:
        if self.cycle_sun is not None and self.cycle_wkday is not None:
            return None
        if self.cycle_sun is not None:
            return ('C', 'A', 'B')[self.cycle_sun % 3]
        if self.cycle_wkday is not None:
            return ('II', 'I')[self.cycle_wkday % 2]
        return None


class TextSourceOption(BaseModel):
    translation_source_code: str
    display_name: Optional[str] = None
    short_code: Optional[str] = None
    printed_page_num: Optional[str] = None
    text_src: Optional[str] = None
    # None when this source has no entry for the epoch+part (offered anyway)
    found_at_slug: Optional[str] = None


class OptionChoice(BaseModel):
    option_num: int
    label: Optional[str] = None


class CompositionDataResponse(BaseModel):
    text: Optional[CompositionText] = None
    chant: Optional[CompositionChant] = None
    text_source_options: List[TextSourceOption] = []
    text_options: List[OptionChoice] = []
    chant_options: List[OptionChoice] = []
    local_chants: List[LocalChantSummary] = []


class NewLocalChantBody(BaseModel):
    gabc: str
    version: str = 'english'
    incipit: Optional[str] = None
    office_part: Optional[str] = None
    mode: Optional[str] = None
    transcriber: str = 'Doctor J'
    translation_source_code: Optional[str] = None
    source_citation: Optional[str] = None
    is_text_exact: int = 1
    derived_from_uid: Optional[str] = None
    status: str = 'draft'
    commentary: Optional[str] = None
    chant_group_mode: str                  # 'new' or 'derived'
    canonical_name: Optional[str] = None   # required when chant_group_mode='new'


class NewLocalChantResponse(BaseModel):
    local_chant_id: str
    chant_group_id: int
    incipit: Optional[str] = None
    mode: Optional[str] = None
    version: Optional[str] = None
    status: str


class GregobaseChantResult(BaseModel):
    id: int
    incipit: Optional[str] = None
    mode: Optional[str] = None
    version: Optional[str] = None
    part: Optional[str] = None
    transcriber: Optional[str] = None
    gabc_body: Optional[str] = None


def _gie_from_row(r, include_gabc: bool = False) -> GrIndexEntry:
    gb_gabc_body = None
    lc_gabc_body = None
    if include_gabc:
        if r['gb_gabc']:
            gb_gabc_body = extract_gabc_body(r['gb_gabc'] or '')
        if r['lc_gabc']:
            lc_gabc = r['lc_gabc'] or ''
            parts = lc_gabc.split('%%')
            lc_gabc_body = parts[-1].strip() if len(parts) > 1 else lc_gabc.strip()
    return GrIndexEntry(
        row_id=r['row_id'],
        page=r['page'],
        page_idx=r['page_idx'],
        section_type=r['section_type'],
        mode=r['mode'],
        incipit=r['incipit'],
        match_status=r['match_status'],
        gregobase_id=r['gregobase_id'],
        local_chant_id=r['local_chant_id'],
        gb_incipit=r['gb_incipit'] if include_gabc else None,
        gb_gabc_body=gb_gabc_body,
        lc_incipit=r['lc_incipit'] if include_gabc else None,
        lc_gabc_body=lc_gabc_body,
    )


_GIE_SELECT = """
    SELECT gie.row_id, gie.page, gie.page_idx, gie.section_type, gie.mode, gie.incipit,
           gie.match_status, gie.gregobase_id, gie.local_chant_id,
           gc.incipit AS gb_incipit, gc.gabc AS gb_gabc,
           lc.incipit AS lc_incipit, lc.gabc AS lc_gabc
    FROM gr_index_entry gie
    LEFT JOIN gregobase_chants gc ON gc.id = gie.gregobase_id
    LEFT JOIN local_chants lc ON lc.local_chant_id = gie.local_chant_id
"""


@app.get("/api/gr_index_entries", response_model=List[GrIndexEntry])
def list_gr_index_entries(
    match_status: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = Query(1000, le=2000),
    offset: int = 0,
):
    conditions = []
    params: dict = {'limit': limit, 'offset': offset}
    if match_status == '(none)':
        conditions.append("gie.match_status IS NULL")
    elif match_status:
        conditions.append("gie.match_status = :match_status")
        params['match_status'] = match_status
    if q:
        conditions.append("LOWER(gie.incipit) LIKE :q")
        params['q'] = f'%{q.lower()}%'
    where = ('WHERE ' + ' AND '.join(conditions)) if conditions else ''
    sql = text(f"""
        {_GIE_SELECT}
        {where}
        ORDER BY gie.section_type, gie.incipit
        LIMIT :limit OFFSET :offset
    """)
    try:
        with ro().connect() as conn:
            rows = conn.execute(sql, params).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return [_gie_from_row(r, include_gabc=False) for r in rows]


@app.get("/api/gr_index_entries/{row_id}", response_model=GrIndexEntry)
def get_gr_index_entry(row_id: int):
    try:
        with ro().connect() as conn:
            row = conn.execute(
                text(f"{_GIE_SELECT} WHERE gie.row_id = :rid"),
                {'rid': row_id},
            ).mappings().fetchone()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    if not row:
        raise HTTPException(404, "GR index entry not found")
    return _gie_from_row(row, include_gabc=True)


@app.patch("/api/gr_index_entries/{row_id}", response_model=GrIndexEntry)
def update_gr_index_entry(row_id: int, body: GrIndexEntryUpdate):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "No fields to update")
    set_clause = ", ".join(f"{col} = :{col}" for col in fields)
    params = dict(fields)
    params['rid'] = row_id
    try:
        with rw().begin() as conn:
            result = conn.execute(
                text(f"UPDATE gr_index_entry SET {set_clause} WHERE row_id = :rid"),
                params,
            )
            if result.rowcount == 0:
                exists = conn.execute(
                    text("SELECT 1 FROM gr_index_entry WHERE row_id = :rid"),
                    {'rid': row_id},
                ).fetchone()
                if not exists:
                    raise HTTPException(404, "GR index entry not found")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return get_gr_index_entry(row_id)


@app.get("/api/gregobase_chants", response_model=List[GregobaseChantResult])
def search_gregobase_chants(
    q: Optional[str] = None,
    mode: Optional[str] = None,
    part: Optional[str] = None,
    limit: int = Query(40, le=200),
    offset: int = 0,
):
    conditions = []
    params: dict = {'limit': limit, 'offset': offset}
    if q:
        conditions.append("LOWER(gc.incipit) LIKE :q")
        params['q'] = f'%{q.lower()}%'
    if mode:
        conditions.append("gc.mode = :mode")
        params['mode'] = mode
    if part:
        conditions.append("gc.`office-part` = :part")
        params['part'] = part
    where = ('WHERE ' + ' AND '.join(conditions)) if conditions else ''
    sql = text(f"""
        SELECT gc.id, gc.incipit, gc.mode, gc.version,
               gc.`office-part` AS part, gc.transcriber, gc.gabc
        FROM gregobase_chants gc
        {where}
        ORDER BY gc.incipit, gc.id
        LIMIT :limit OFFSET :offset
    """)
    try:
        with ro().connect() as conn:
            rows = conn.execute(sql, params).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return [
        GregobaseChantResult(
            id=r['id'],
            incipit=r['incipit'],
            mode=str(r['mode']) if r['mode'] is not None else None,
            version=r['version'],
            part=r['part'],
            transcriber=r['transcriber'],
            gabc_body=extract_gabc_body(r['gabc'] or '') if r['gabc'] else None,
        )
        for r in rows
    ]


_VERSION_RANK = """
    CASE gc2.version
        WHEN 'Solesmes 1974' THEN 1
        WHEN 'Solesmes 1961' THEN 2
        WHEN 'Solesmes'      THEN 3
        WHEN 'Vatican'       THEN 4
        ELSE 5
    END
"""


class GrIndexBrowseGroup(BaseModel):
    chant_group_id: int
    canonical_name: Optional[str] = None
    incipit: Optional[str] = None
    best_gregobase_id: int
    best_version: Optional[str] = None
    best_mode: Optional[str] = None
    best_gabc_body: Optional[str] = None


class GregobaseChantEntry(BaseModel):
    gregobase_id: int
    incipit: Optional[str] = None
    mode: Optional[str] = None
    version: Optional[str] = None
    transcriber: Optional[str] = None
    gabc_body: Optional[str] = None


@app.get("/api/gregobase_parts")
def gregobase_parts():
    """Return distinct office-part codes that appear in gregobase_chants mapped to a chant group."""
    sql = text("""
        SELECT DISTINCT gc.`office-part` AS part
        FROM gregobase_chants gc
        JOIN gregobase_chant_group_map gcm ON gcm.gregobase_id = gc.id
        WHERE gc.`office-part` IS NOT NULL AND gc.`office-part` != ''
        ORDER BY gc.`office-part`
    """)
    try:
        with ro().connect() as conn:
            rows = conn.execute(sql).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return [r['part'] for r in rows]


@app.get("/api/gregobase_letters")
def gregobase_letters(part: str, prefix: str = ''):
    """Return distinct (prefix+1)-char prefixes of chant_group.incipit for the given part.
    Without prefix: first letters. With prefix='A': distinct two-char prefixes starting with A."""
    n = len(prefix) + 1
    prefix_clause = "AND UPPER(LEFT(cg.incipit, :plen)) = :prefix" if prefix else ""
    sql = text(f"""
        SELECT DISTINCT UPPER(LEFT(cg.incipit, {n})) AS letter
        FROM chant_group cg
        JOIN gregobase_chant_group_map gcm ON gcm.chant_group_id = cg.chant_group_id
        JOIN gregobase_chants gc ON gc.id = gcm.gregobase_id
        WHERE gc.`office-part` = :part
          AND cg.incipit IS NOT NULL AND cg.incipit != ''
          {prefix_clause}
        ORDER BY letter
    """)
    params: dict = {'part': part}
    if prefix:
        params['prefix'] = prefix.upper()
        params['plen'] = len(prefix)
    try:
        with ro().connect() as conn:
            rows = conn.execute(sql, params).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return [r['letter'] for r in rows]


@app.get("/api/gr_index_browse", response_model=List[GrIndexBrowseGroup])
def browse_gr_index_groups(
    part: str,
    letter: str = '',
    prefix: str = '',
    limit: int = Query(300, le=1000),
    offset: int = 0,
):
    """List chant groups that have a gregobase chant with the given office-part.
    Filtered by `prefix` (any length) or legacy `letter` param (1 char).
    For each group returns the best-version gregobase chant
    (Solesmes 1974 > 1961 > Solesmes > Vatican > rest).
    """
    pfx = (prefix or letter).upper()
    params: dict = {'part': part, 'limit': limit, 'offset': offset}
    letter_clause = ""
    if pfx:
        letter_clause = "AND UPPER(LEFT(COALESCE(cg.incipit, ''), :plen)) = :prefix"
        params['prefix'] = pfx
        params['plen'] = len(pfx)

    sql = text(f"""
        SELECT
            cg.chant_group_id, cg.canonical_name, cg.incipit,
            best_gc.id      AS best_gregobase_id,
            best_gc.version AS best_version,
            best_gc.mode    AS best_mode,
            best_gc.gabc    AS best_gabc
        FROM chant_group cg
        JOIN gregobase_chants best_gc ON best_gc.id = (
            SELECT gc2.id
            FROM gregobase_chant_group_map gcm2
            JOIN gregobase_chants gc2 ON gc2.id = gcm2.gregobase_id
            WHERE gcm2.chant_group_id = cg.chant_group_id
              AND gc2.`office-part` = :part
            ORDER BY {_VERSION_RANK}, gc2.id
            LIMIT 1
        )
        WHERE 1=1 {letter_clause}
        ORDER BY cg.incipit
        LIMIT :limit OFFSET :offset
    """)
    try:
        with ro().connect() as conn:
            rows = conn.execute(sql, params).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return [
        GrIndexBrowseGroup(
            chant_group_id=r['chant_group_id'],
            canonical_name=r['canonical_name'],
            incipit=r['incipit'],
            best_gregobase_id=r['best_gregobase_id'],
            best_version=r['best_version'],
            best_mode=str(r['best_mode']) if r['best_mode'] is not None else None,
            best_gabc_body=extract_gabc_body(r['best_gabc'] or '') if r['best_gabc'] else None,
        )
        for r in rows
    ]


@app.get("/api/chant_groups/{group_id}/gregobase_chants", response_model=List[GregobaseChantEntry])
def gregobase_chants_in_group(group_id: int):
    """Return all gregobase chants for the given chant group, ordered by version preference."""
    sql = text(f"""
        SELECT gc.id AS gregobase_id, gc.incipit, gc.mode, gc.version, gc.transcriber, gc.gabc
        FROM gregobase_chants gc
        JOIN gregobase_chant_group_map gcm ON gc.id = gcm.gregobase_id
        WHERE gcm.chant_group_id = :gid
        ORDER BY {_VERSION_RANK}, gc.id
    """)
    try:
        with ro().connect() as conn:
            rows = conn.execute(sql, {'gid': group_id}).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return [
        GregobaseChantEntry(
            gregobase_id=r['gregobase_id'],
            incipit=r['incipit'],
            mode=str(r['mode']) if r['mode'] is not None else None,
            version=r['version'],
            transcriber=r['transcriber'],
            gabc_body=extract_gabc_body(r['gabc'] or '') if r['gabc'] else None,
        )
        for r in rows
    ]


@app.post("/api/gr_index_entries/{row_id}/local_chant", response_model=GrIndexEntry)
def create_local_chant_for_gr_entry(row_id: int, body: NewLocalChantRequest):
    """Create a new local_chants row + chant_group from pasted GABC and assign to the entry."""
    gabc = body.gabc.strip()
    if not gabc:
        raise HTTPException(400, "gabc cannot be empty")

    try:
        with ro().connect() as conn:
            entry = conn.execute(
                text("SELECT row_id, section_type, mode, incipit FROM gr_index_entry WHERE row_id = :rid"),
                {'rid': row_id},
            ).mappings().fetchone()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    if not entry:
        raise HTTPException(404, "GR index entry not found")

    incipit = (body.incipit or entry['incipit'] or '').strip() or None
    canonical_name = (body.canonical_name or incipit or f"GR index entry {row_id}").strip()
    mode_val = body.mode or (str(entry['mode']) if entry['mode'] is not None else None)
    part_code = SECTION_TO_PART_CODE.get((entry['section_type'] or '').lower())
    version = (body.version or 'latin').strip()
    new_id = str(uuid.uuid4())

    try:
        with rw().begin() as conn:
            group_result = conn.execute(text("""
                INSERT INTO chant_group (canonical_name, incipit)
                VALUES (:name, :inc)
            """), {'name': canonical_name, 'inc': incipit})
            group_id = group_result.lastrowid

            conn.execute(text("""
                INSERT INTO local_chants
                    (local_chant_id, chant_group_id, incipit, office_part, mode, version, gabc, status)
                VALUES
                    (:lid, :gid, :inc, :part, :mode, :version, :gabc, 'draft')
            """), {
                'lid': new_id,
                'gid': group_id,
                'inc': incipit,
                'part': part_code,
                'mode': mode_val,
                'version': version,
                'gabc': gabc,
            })

            conn.execute(text("""
                UPDATE gr_index_entry
                SET local_chant_id = :lid, match_status = 'reviewed'
                WHERE row_id = :rid
            """), {'lid': new_id, 'rid': row_id})
    except Exception as exc:
        raise HTTPException(503, str(exc))

    return get_gr_index_entry(row_id)


@app.post("/api/lit_part_assignments/{text_id}/local_chant", response_model=LitPartAssignmentReview)
def create_local_chant_for_assignment(text_id: int, body: NewLocalChantRequest):
    """Create a new local_chants row + chant_group and assign it to the lit_part_sources row."""
    gabc = body.gabc.strip()
    if not gabc:
        raise HTTPException(400, "gabc cannot be empty")
    try:
        with ro().connect() as conn:
            asgn = conn.execute(text("""
                SELECT lps.text_id, sp.part_code
                FROM lit_part_sources lps
                JOIN service_part sp ON sp.part_id = lps.part_id
                WHERE lps.text_id = :tid
            """), {'tid': text_id}).mappings().fetchone()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    if not asgn:
        raise HTTPException(404, "Assignment not found")
    incipit = (body.incipit or '').strip() or None
    canonical_name = (body.canonical_name or incipit or f"Assignment {text_id}").strip()
    mode_val = (body.mode or '').strip() or None
    version = (body.version or 'latin').strip()
    new_id = str(uuid.uuid4())
    try:
        with rw().begin() as conn:
            group_result = conn.execute(text("""
                INSERT INTO chant_group (canonical_name, incipit) VALUES (:name, :inc)
            """), {'name': canonical_name, 'inc': incipit})
            group_id = group_result.lastrowid
            conn.execute(text("""
                INSERT INTO local_chants
                    (local_chant_id, chant_group_id, incipit, office_part, mode, version, gabc, status)
                VALUES (:lid, :gid, :inc, :part, :mode, :version, :gabc, 'draft')
            """), {
                'lid': new_id, 'gid': group_id, 'inc': incipit,
                'part': asgn['part_code'], 'mode': mode_val,
                'version': version, 'gabc': gabc,
            })
            conn.execute(text("""
                UPDATE lit_part_sources SET chant_uuid = :uuid WHERE text_id = :tid
            """), {'uuid': f'local:{new_id}', 'tid': text_id})
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return get_lit_part_assignment(text_id)


# ── Composition workflow ───────────────────────────────────────────────────────

@app.get("/api/lit_epochs/{slug}/composition_parts")
def epoch_composition_parts(slug: str, chant_source: Optional[str] = None):
    """Distinct service parts and section page images for the full epoch hierarchy.

    Parts come from any lit_part_sources row (text or chant) across ancestors,
    self, and descendants — no chant_uuid filter.
    Pages come from rows in the hierarchy that match chant_source and have a book/page.
    """
    try:
        with ro().connect() as conn:
            epoch_row = conn.execute(text(
                "SELECT slug, kind, title FROM lit_epoch WHERE slug=:s"
            ), {'s': slug}).mappings().fetchone()
            if not epoch_row:
                raise HTTPException(404, "Epoch not found")

            all_slugs = _epoch_all_related_slugs(conn, slug)
            in_ph = ', '.join(f':sl{i}' for i in range(len(all_slugs)))
            in_params = {f'sl{i}': s for i, s in enumerate(all_slugs)}

            # One chip per (epoch, part, cycle) — options are chosen per-pane in
            # composition_data, since option numbering is independent across sources.
            part_rows = conn.execute(text(f"""
                SELECT lps.lit_epoch_slug, le.title AS epoch_title,
                       sp.part_code, sp.display_name AS part_name,
                       lps.cycle_sun, lps.cycle_wkday, lps.wkday
                FROM lit_part_sources lps
                JOIN service_part sp ON sp.part_id = lps.part_id
                JOIN lit_epoch le ON le.slug = lps.lit_epoch_slug
                WHERE lps.lit_epoch_slug IN ({in_ph})
                GROUP BY lps.lit_epoch_slug, le.title, sp.part_code,
                         sp.display_name, sp.display_order, le.sort_order,
                         lps.cycle_sun, lps.cycle_wkday, lps.wkday
                ORDER BY sp.display_order, le.sort_order, lps.lit_epoch_slug, lps.wkday
            """), in_params).mappings().fetchall()

            page_rows = []
            if chant_source:
                pg_params = dict(in_params, csrc=chant_source)
                page_rows = conn.execute(text(f"""
                    SELECT lps.book, lps.printed_page_num
                    FROM lit_part_sources lps
                    JOIN service_part sp ON sp.part_id = lps.part_id
                    WHERE lps.lit_epoch_slug IN ({in_ph})
                      AND lps.assignment_authority_code = :csrc
                      AND lps.book IS NOT NULL
                      AND lps.printed_page_num IS NOT NULL
                    GROUP BY lps.book, lps.printed_page_num
                    ORDER BY lps.book,
                             CAST(lps.printed_page_num AS UNSIGNED),
                             lps.printed_page_num
                """), pg_params).mappings().fetchall()

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))

    return {
        "epoch": dict(epoch_row),
        "parts": [{"epoch_slug": r["lit_epoch_slug"], "epoch_title": r["epoch_title"],
                    "part_code": r["part_code"], "part_name": r["part_name"],
                    "cycle_sun": r["cycle_sun"], "cycle_wkday": r["cycle_wkday"],
                    "cycle": _cycle_str(r["cycle_sun"], r["cycle_wkday"]),
                    "wkday": r["wkday"]} for r in part_rows],
        "pages": [{"book": r["book"], "printed_page_num": str(r["printed_page_num"])} for r in page_rows],
    }


@app.get("/api/composition/sources")
def composition_sources():
    """Distinct assignment_authority_code values for sources that have text data (text_sources)
    and for sources that have a chant assigned (chant_sources)."""
    try:
        with ro().connect() as conn:
            text_rows = conn.execute(text("""
                SELECT lps.translation_source_code, pts.display_name, pts.sort_order
                FROM lit_part_sources lps
                LEFT JOIN p_translation_source pts
                       ON pts.translation_source_code = lps.translation_source_code
                WHERE lps.translation_source_code IS NOT NULL
                  AND lps.vernacular_text IS NOT NULL
                GROUP BY lps.translation_source_code, pts.display_name, pts.sort_order
                ORDER BY pts.sort_order
            """)).mappings().fetchall()
            chant_rows = conn.execute(text("""
                SELECT lps.assignment_authority_code, paa.display_name
                FROM lit_part_sources lps
                LEFT JOIN p_assignment_authority paa
                       ON paa.authority_code = lps.assignment_authority_code
                WHERE lps.assignment_authority_code IS NOT NULL
                  AND lps.chant_uuid IS NOT NULL
                GROUP BY lps.assignment_authority_code, paa.display_name, paa.sort_order
                ORDER BY paa.sort_order
            """)).mappings().fetchall()
    except Exception as exc:
        raise HTTPException(503, str(exc))
    return {
        "text_sources":  [{"code": r["translation_source_code"], "display_name": r["display_name"] or r["translation_source_code"]} for r in text_rows],
        "chant_sources": [{"code": r["assignment_authority_code"], "display_name": r["display_name"] or r["assignment_authority_code"]} for r in chant_rows],
    }


def _cycle_str(cycle_sun, cycle_wkday) -> Optional[str]:
    if cycle_sun is not None:
        return ('C', 'A', 'B')[cycle_sun % 3]
    if cycle_wkday is not None:
        return ('II', 'I')[cycle_wkday % 2]
    return None


def _text_option_label(latin: Optional[str], eng: Optional[str]) -> Optional[str]:
    """Short incipit-style label for a text option dropdown entry."""
    s = (latin or eng or '').strip().replace('\n', ' ')
    if not s:
        return None
    return (s[:40] + '…') if len(s) > 40 else s


def _chant_option_label(incipit: Optional[str], mode: Optional[str]) -> Optional[str]:
    """Short label for a chant option dropdown entry: incipit · mode N."""
    parts = []
    if incipit:
        parts.append(incipit.strip())
    if mode:
        parts.append(f'mode {mode}')
    return ' · '.join(parts) or None


def _collect_options(rows, label_fn) -> List["OptionChoice"]:
    """Build a deduplicated (by option_num) OptionChoice list from ordered rows.
    A source can have several rows per option (e.g. one per translation), so the
    first row for each option_num wins its label."""
    opts: List[OptionChoice] = []
    seen: set = set()
    for r in rows:
        on = r['option_num'] or 1
        if on in seen:
            continue
        seen.add(on)
        opts.append(OptionChoice(option_num=on, label=label_fn(r)))
    return opts


_EPOCH_ROW_COLS = "slug, kind, title, season, subseason, wknum, sort_order"


def _epoch_hierarchy(conn, slug: str):
    """Fetch a lit_epoch row along with its ancestor and descendant rows.

    Ancestors are outermost first (season, subseason, week), including only the
    levels that apply to the epoch's own kind. Descendants are direct children in
    sort_order (season -> everything but season; subseason -> week/day/mass;
    week -> day/mass; saint -> its Vigil Mass; day/mass have none). wknum=0 is a
    real value (e.g. Ash Wednesday's week, Holy Week, the O Antiphons) so it's
    checked with `is not None`, never plain truthiness.

    Returns (epoch, ancestors, descendants) as dicts with _EPOCH_ROW_COLS fields;
    epoch is None and the lists are empty if slug doesn't exist.
    """
    row = conn.execute(text(
        f"SELECT {_EPOCH_ROW_COLS} FROM lit_epoch WHERE slug = :s"
    ), {'s': slug}).mappings().fetchone()
    if not row:
        return None, [], []
    epoch = dict(row)
    kind, season, subseason, wknum = epoch['kind'], epoch['season'], epoch['subseason'], epoch['wknum']

    ancestors: list[dict] = []
    if kind in ('day', 'mass', 'week', 'subseason') and season:
        r = conn.execute(text(
            f"SELECT {_EPOCH_ROW_COLS} FROM lit_epoch WHERE kind='season' AND season=:s LIMIT 1"
        ), {'s': season}).mappings().fetchone()
        if r: ancestors.append(dict(r))
    if kind in ('day', 'mass', 'week') and season and subseason:
        r = conn.execute(text(
            f"SELECT {_EPOCH_ROW_COLS} FROM lit_epoch WHERE kind='subseason' AND season=:s AND subseason=:ss LIMIT 1"
        ), {'s': season, 'ss': subseason}).mappings().fetchone()
        if r: ancestors.append(dict(r))
    if kind in ('day', 'mass') and season and subseason and wknum is not None:
        r = conn.execute(text(
            f"SELECT {_EPOCH_ROW_COLS} FROM lit_epoch WHERE kind='week' AND season=:s AND subseason=:ss AND wknum=:w LIMIT 1"
        ), {'s': season, 'ss': subseason, 'w': wknum}).mappings().fetchone()
        if r: ancestors.append(dict(r))

    if kind == 'season' and season:
        desc_rows = conn.execute(text(
            f"SELECT {_EPOCH_ROW_COLS} FROM lit_epoch WHERE season=:s AND kind!='season' ORDER BY sort_order, slug"
        ), {'s': season}).mappings().fetchall()
    elif kind == 'subseason' and season and subseason:
        desc_rows = conn.execute(text(
            f"SELECT {_EPOCH_ROW_COLS} FROM lit_epoch WHERE season=:s AND subseason=:ss"
            " AND kind IN ('week','day','mass') ORDER BY sort_order, slug"
        ), {'s': season, 'ss': subseason}).mappings().fetchall()
    elif kind == 'week' and season and subseason and wknum is not None:
        desc_rows = conn.execute(text(
            f"SELECT {_EPOCH_ROW_COLS} FROM lit_epoch WHERE season=:s AND subseason=:ss AND wknum=:w"
            " AND kind IN ('day','mass') ORDER BY sort_order, slug"
        ), {'s': season, 'ss': subseason, 'w': wknum}).mappings().fetchall()
    elif kind in ('saint', 'common'):
        # Sanctorale Vigil Masses are kind='mass' with NULL season/subseason/wknum,
        # and the Commons sit outside the calendar entirely, so the temporal
        # descendant queries above can never reach either — their only link to the
        # parent is the explicit lit_epoch_tree edge. For a Commons container
        # (COM-DED, COM-SANCT, ...) that edge is what surfaces the formularies
        # underneath it; the container itself carries no lit_part_sources rows.
        desc_rows = conn.execute(text(
            f"SELECT {_EPOCH_ROW_COLS} FROM lit_epoch"
            " JOIN lit_epoch_tree t ON t.child_slug = lit_epoch.slug"
            " WHERE t.parent_slug = :s ORDER BY sort_order, slug"
        ), {'s': slug}).mappings().fetchall()
    else:
        desc_rows = []
    descendants = [dict(r) for r in desc_rows]

    return epoch, ancestors, descendants


def _epoch_all_related_slugs(conn, slug: str) -> list[str]:
    """Return every slug in the epoch's full hierarchy: ancestors first, then self, then descendants."""
    epoch, ancestors, descendants = _epoch_hierarchy(conn, slug)
    if epoch is None:
        return [slug]
    slugs = [a['slug'] for a in ancestors] + [slug] + [d['slug'] for d in descendants]
    return list(dict.fromkeys(slugs))  # dedup, preserve order


def _epoch_ancestor_slugs(conn, slug: str) -> list[str]:
    """Return [slug, week_slug?, subseason_slug?, season_slug?] in fallback order."""
    epoch, ancestors, _ = _epoch_hierarchy(conn, slug)
    if epoch is None:
        return [slug]
    return [slug] + [a['slug'] for a in reversed(ancestors)]


@app.get("/api/lit_epochs/{slug}/composition_data", response_model=CompositionDataResponse)
def epoch_composition_data(
    slug: str,
    part_code: str = Query(...),
    text_source: Optional[str] = None,
    chant_source: Optional[str] = None,
    cycle_sun: Optional[int] = None,
    cycle_wkday: Optional[int] = None,
    wkday: Optional[int] = None,
    text_option_num: Optional[int] = None,
    chant_option_num: Optional[int] = None,
):
    """For a given epoch + part, return text (Latin/English) and chant (GABC)
    from the specified sources, with ancestor fallback when the exact epoch has no data.

    Text and chant options are selected independently: option numbering is per-source
    (e.g. the Roman Missal's single antiphon does not map to the Graduale's option list),
    so text_option_num and chant_option_num are resolved against their own source's rows.
    When an option is not supplied, the lowest-numbered option for that source is used.

    `wkday` (1=Sun..7=Sat) disambiguates weekday-generic parts stored at a single
    slug with no per-day epoch (e.g. ADV-II's "in ultimis feriis" ferias) — distinct
    from `cycle_sun`/`cycle_wkday`, which select the Sunday-cycle A/B/C or weekday
    Psalter I/II reading."""
    try:
        with ro().connect() as conn:
            if not conn.execute(text("SELECT 1 FROM lit_epoch WHERE slug=:s"), {'s': slug}).fetchone():
                raise HTTPException(404, "Epoch not found")

            slugs = _epoch_ancestor_slugs(conn, slug)

            composition_text: Optional[CompositionText] = None
            text_options: List[OptionChoice] = []
            if text_source:
                wkday_clause = ''
                wkday_params: dict = {}
                if wkday is not None:
                    wkday_clause = 'AND lps.wkday = :wkday'
                    wkday_params['wkday'] = wkday
                # Resolve the most specific slug that has any text for this source,
                # list all of its options, then pick the requested one (or the lowest).
                for try_slug in slugs:
                    t_rows = conn.execute(text(f"""
                        SELECT lps.text_id, lps.option_num,
                               COALESCE(lps.original_text, gct.text) AS original_text,
                               lps.vernacular_text, lps.text_src,
                               lps.lit_epoch_slug, le.title AS epoch_title,
                               lps.translation_source_code,
                               pts.short_code AS translation_short_code,
                               COALESCE(lps.ref_page_num, lps.printed_page_num) AS text_page_num,
                               lps.book, lps.printed_page_num AS src_page_num,
                               lps.bbox, lps.review_status
                        FROM lit_part_sources lps
                        JOIN service_part sp ON sp.part_id = lps.part_id
                        LEFT JOIN lit_epoch le ON le.slug = lps.lit_epoch_slug
                        LEFT JOIN gregobase_chants_texts gct
                               ON lps.chant_uuid = CONCAT('gregobase:', gct.id)
                        LEFT JOIN p_translation_source pts
                               ON pts.translation_source_code = lps.translation_source_code
                        WHERE lps.lit_epoch_slug = :try_slug
                          AND sp.part_code = :part
                          AND lps.translation_source_code = :tsrc
                          AND lps.vernacular_text IS NOT NULL
                          {wkday_clause}
                        ORDER BY lps.option_num
                    """), {'try_slug': try_slug, 'part': part_code, 'tsrc': text_source, **wkday_params}
                    ).mappings().fetchall()
                    if t_rows:
                        text_options = _collect_options(
                            t_rows,
                            lambda r: _text_option_label(r['original_text'], r['vernacular_text']),
                        )
                        chosen = None
                        if text_option_num is not None:
                            chosen = next((r for r in t_rows if (r['option_num'] or 1) == text_option_num), None)
                        if chosen is None:
                            chosen = t_rows[0]
                        composition_text = CompositionText(
                            text_id=chosen['text_id'],
                            option_num=chosen['option_num'] or 1,
                            original_text=chosen['original_text'],
                            vernacular_text=chosen['vernacular_text'],
                            text_src=chosen['text_src'],
                            found_at_slug=chosen['lit_epoch_slug'],
                            found_at_title=chosen['epoch_title'],
                            translation_source_code=chosen['translation_source_code'],
                            translation_short_code=chosen['translation_short_code'],
                            text_page_num=str(chosen['text_page_num']) if chosen['text_page_num'] is not None else None,
                            book=chosen['book'],
                            printed_page_num=str(chosen['src_page_num']) if chosen['src_page_num'] is not None else None,
                            bbox=chosen['bbox'],
                            review_status=chosen['review_status'],
                        )
                        break

            composition_chant: Optional[CompositionChant] = None
            chant_options: List[OptionChoice] = []
            if chant_source:
                cycle_clause = ''
                cycle_params: dict = {}
                if cycle_sun is not None:
                    cycle_clause = 'AND lps.cycle_sun = :cycle_sun'
                    cycle_params['cycle_sun'] = cycle_sun
                elif cycle_wkday is not None:
                    cycle_clause = 'AND lps.cycle_wkday = :cycle_wkday'
                    cycle_params['cycle_wkday'] = cycle_wkday
                wkday_clause = ''
                wkday_params: dict = {}
                if wkday is not None:
                    wkday_clause = 'AND lps.wkday = :wkday'
                    wkday_params['wkday'] = wkday
                for try_slug in slugs:
                    c_rows = conn.execute(text(f"""
                        SELECT lps.text_id, lps.option_num, lps.chant_uuid,
                               lps.lit_epoch_slug, le.title AS epoch_title,
                               lps.book, lps.printed_page_num,
                               COALESCE(lps.ref_page_num, lps.printed_page_num) AS chant_page_num,
                               COALESCE((
                                   SELECT eng.bbox FROM lit_part_sources eng
                                   WHERE lps.ref_page_num IS NOT NULL
                                     AND eng.book = lps.book
                                     AND eng.printed_page_num = lps.ref_page_num
                                     AND eng.chant_uuid = lps.chant_uuid
                                   LIMIT 1
                               ), lps.bbox) AS bbox,
                               COALESCE(lps.original_text, gct.text) AS original_text,
                               COALESCE((
                                   SELECT eng.text_src FROM lit_part_sources eng
                                   WHERE lps.ref_page_num IS NOT NULL
                                     AND eng.book = lps.book
                                     AND eng.printed_page_num = lps.ref_page_num
                                     AND eng.chant_uuid = lps.chant_uuid
                                   LIMIT 1
                               ), lps.text_src) AS text_src,
                               pts.short_code AS translation_short_code,
                               lps.review_status,
                               lps.cycle_sun, lps.cycle_wkday, lps.wkday,
                               COALESCE(gc.incipit, lc.incipit) AS opt_incipit,
                               COALESCE(gc.mode, lc.mode) AS opt_mode
                        FROM lit_part_sources lps
                        JOIN service_part sp ON sp.part_id = lps.part_id
                        LEFT JOIN lit_epoch le ON le.slug = lps.lit_epoch_slug
                        LEFT JOIN p_translation_source pts
                               ON pts.translation_source_code = lps.translation_source_code
                        LEFT JOIN gregobase_chants gc
                               ON lps.chant_uuid = CONCAT('gregobase:', gc.id)
                        LEFT JOIN local_chants lc
                               ON lps.chant_uuid = CONCAT('local:', lc.local_chant_id)
                        LEFT JOIN gregobase_chants_texts gct
                               ON lps.chant_uuid = CONCAT('gregobase:', gct.id)
                        WHERE lps.lit_epoch_slug = :try_slug
                          AND sp.part_code = :part
                          AND lps.assignment_authority_code = :csrc
                          AND lps.chant_uuid IS NOT NULL
                          {cycle_clause}
                          {wkday_clause}
                        ORDER BY lps.option_num
                    """), {'try_slug': try_slug, 'part': part_code, 'csrc': chant_source, **cycle_params, **wkday_params}
                    ).mappings().fetchall()
                    if c_rows:
                        chant_options = _collect_options(
                            c_rows,
                            lambda r: _chant_option_label(r['opt_incipit'], r['opt_mode']),
                        )
                        c_row = None
                        if chant_option_num is not None:
                            c_row = next((r for r in c_rows if (r['option_num'] or 1) == chant_option_num), None)
                        if c_row is None:
                            c_row = c_rows[0]
                        chant_uuid = c_row['chant_uuid']
                        gabc_body = ''
                        incipit = mode = version = None
                        if chant_uuid.startswith('gregobase:'):
                            gid = int(chant_uuid.split(':', 1)[1])
                            g = conn.execute(text(
                                "SELECT incipit, gabc, mode, version FROM gregobase_chants WHERE id=:gid"
                            ), {'gid': gid}).mappings().fetchone()
                            if g:
                                gabc_body = extract_gabc_body(g['gabc'] or '')
                                incipit, mode, version = g['incipit'], g['mode'], g['version']
                        elif chant_uuid.startswith('local:'):
                            lid = chant_uuid.split(':', 1)[1]
                            lc = conn.execute(text(
                                "SELECT incipit, gabc, mode, version FROM local_chants WHERE local_chant_id=:lid"
                            ), {'lid': lid}).mappings().fetchone()
                            if lc:
                                raw = lc['gabc'] or ''
                                parts = raw.split('%%')
                                gabc_body = parts[-1].strip() if len(parts) > 1 else raw.strip()
                                incipit, mode, version = lc['incipit'], lc['mode'], lc['version']
                        composition_chant = CompositionChant(
                            text_id=c_row['text_id'],
                            option_num=c_row['option_num'] or 1,
                            chant_uuid=chant_uuid,
                            gabc_body=gabc_body,
                            original_text=c_row['original_text'],
                            incipit=incipit,
                            mode=mode,
                            version=version,
                            found_at_slug=c_row['lit_epoch_slug'],
                            found_at_title=c_row['epoch_title'],
                            book=c_row['book'],
                            printed_page_num=str(c_row['printed_page_num']) if c_row['printed_page_num'] is not None else None,
                            chant_page_num=str(c_row['chant_page_num']) if c_row['chant_page_num'] is not None else None,
                            bbox=c_row['bbox'],
                            text_src=c_row['text_src'],
                            translation_short_code=c_row['translation_short_code'],
                            review_status=c_row['review_status'],
                            cycle_sun=c_row['cycle_sun'],
                            cycle_wkday=c_row['cycle_wkday'],
                            wkday=c_row['wkday'],
                        )
                        break

            # Local chants in the same chant_group as the source chant
            local_chants_in_group: List[LocalChantSummary] = []
            if composition_chant:
                uuid_val = composition_chant.chant_uuid
                group_id = None
                if uuid_val.startswith('gregobase:'):
                    gid_int = int(uuid_val.split(':', 1)[1])
                    grp = conn.execute(text(
                        "SELECT chant_group_id FROM gregobase_chant_group_map WHERE gregobase_id=:gid LIMIT 1"
                    ), {'gid': gid_int}).mappings().fetchone()
                    if grp:
                        group_id = grp['chant_group_id']
                elif uuid_val.startswith('local:'):
                    lid_val = uuid_val.split(':', 1)[1]
                    grp = conn.execute(text(
                        "SELECT chant_group_id FROM local_chants WHERE local_chant_id=:lid LIMIT 1"
                    ), {'lid': lid_val}).mappings().fetchone()
                    if grp:
                        group_id = grp['chant_group_id']
                if group_id:
                    exclude_id = uuid_val.split(':', 1)[1] if uuid_val.startswith('local:') else None
                    lc_rows = conn.execute(text("""
                        SELECT local_chant_id, incipit, mode, version, gabc, status
                        FROM local_chants
                        WHERE chant_group_id = :gid
                        ORDER BY version, incipit
                    """), {'gid': group_id}).mappings().fetchall()
                    for lc_r in lc_rows:
                        if exclude_id and lc_r['local_chant_id'] == exclude_id:
                            continue
                        raw = lc_r['gabc'] or ''
                        pts = raw.split('%%')
                        gabc_b = pts[-1].strip() if len(pts) > 1 else raw.strip()
                        local_chants_in_group.append(LocalChantSummary(
                            local_chant_id=lc_r['local_chant_id'],
                            incipit=lc_r['incipit'],
                            mode=lc_r['mode'],
                            version=lc_r['version'],
                            gabc_body=gabc_b,
                            status=lc_r['status'],
                        ))

            # Every active translation source, annotated with this epoch+part's entry
            # when one exists (ancestor fallback). Sources with no entry here are still
            # offered, so Compose can cite a translation not yet assigned to this part.
            text_source_options: List[TextSourceOption] = []
            best: dict = {}
            if slugs:
                opt_ph = ', '.join(f':os{i}' for i in range(len(slugs)))
                opt_params = {f'os{i}': s for i, s in enumerate(slugs)}
                slug_priority = {s: i for i, s in enumerate(slugs)}
                opt_rows = conn.execute(text(f"""
                    SELECT lps.translation_source_code,
                           pts.display_name, pts.short_code, pts.sort_order,
                           lps.printed_page_num, lps.text_src,
                           lps.lit_epoch_slug
                    FROM lit_part_sources lps
                    JOIN service_part sp ON sp.part_id = lps.part_id
                    LEFT JOIN p_translation_source pts
                           ON pts.translation_source_code = lps.translation_source_code
                    WHERE lps.lit_epoch_slug IN ({opt_ph})
                      AND sp.part_code = :opt_part
                      AND lps.vernacular_text IS NOT NULL
                      AND lps.translation_source_code IS NOT NULL
                """), {**opt_params, 'opt_part': part_code}).mappings().fetchall()

                for r in opt_rows:
                    tsrc = r['translation_source_code']
                    priority = slug_priority.get(r['lit_epoch_slug'], -1)
                    if tsrc not in best or priority > best[tsrc][1]:
                        best[tsrc] = (r, priority)

            src_rows = conn.execute(text("""
                SELECT translation_source_code, display_name, short_code, sort_order
                FROM p_translation_source
                WHERE is_active = 1
            """)).mappings().fetchall()
            by_code = {s['translation_source_code']: dict(s) for s in src_rows}

            # A source actually assigned to this part stays listed even if it is
            # inactive or absent from p_translation_source, so the current selection
            # can never be missing from the list.
            for tsrc, (r, _) in best.items():
                by_code.setdefault(tsrc, {
                    'translation_source_code': tsrc,
                    'display_name': r['display_name'],
                    'short_code': r['short_code'],
                    'sort_order': r['sort_order'],
                })

            def _opt_sort_key(code: str):
                entry = best.get(code)
                # entry at this exact epoch first, then ancestor entries, then unassigned
                rank = 2 if entry is None else (0 if entry[0]['lit_epoch_slug'] == slug else 1)
                s = by_code[code]
                order = s['sort_order'] if s['sort_order'] is not None else 9999
                return (rank, order, s['display_name'] or code)

            text_source_options = [
                TextSourceOption(
                    translation_source_code=code,
                    display_name=by_code[code]['display_name'],
                    short_code=by_code[code]['short_code'],
                    printed_page_num=(
                        str(best[code][0]['printed_page_num'])
                        if code in best and best[code][0]['printed_page_num'] else None
                    ),
                    text_src=best[code][0]['text_src'] if code in best else None,
                    found_at_slug=best[code][0]['lit_epoch_slug'] if code in best else None,
                )
                for code in sorted(by_code, key=_opt_sort_key)
            ]

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))

    return CompositionDataResponse(
        text=composition_text,
        chant=composition_chant,
        text_source_options=text_source_options,
        text_options=text_options,
        chant_options=chant_options,
        local_chants=local_chants_in_group,
    )


@app.post("/api/local_chants", response_model=NewLocalChantResponse)
def create_local_chant(body: NewLocalChantBody):
    """Create a new local_chants row. chant_group_mode='new' creates a new chant_group;
    'derived' reuses the chant_group_id from derived_from_uid."""
    gabc = body.gabc.strip()
    if not gabc:
        raise HTTPException(400, "gabc cannot be empty")
    if body.chant_group_mode not in ('new', 'derived'):
        raise HTTPException(400, "chant_group_mode must be 'new' or 'derived'")

    incipit = (body.incipit or '').strip() or None
    mode_val = (body.mode or '').strip() or None
    office_part = (body.office_part or '').strip() or None
    transcriber = (body.transcriber or 'Doctor J').strip()
    commentary = (body.commentary or '').strip() or None

    new_id = str(uuid.uuid4())

    try:
        with rw().begin() as conn:
            if body.chant_group_mode == 'new':
                canonical_name = (body.canonical_name or incipit or f"Composition {new_id[:8]}").strip()
                group_result = conn.execute(text("""
                    INSERT INTO chant_group (canonical_name, incipit) VALUES (:name, :inc)
                """), {'name': canonical_name, 'inc': incipit})
                group_id = group_result.lastrowid
            else:  # derived
                if not body.derived_from_uid:
                    raise HTTPException(400, "derived_from_uid required when chant_group_mode='derived'")
                row = conn.execute(text(
                    "SELECT chant_group_id FROM v_chant_item WHERE chant_item_uid = :uid"
                ), {'uid': body.derived_from_uid}).fetchone()
                if not row:
                    raise HTTPException(404, f"Source chant {body.derived_from_uid!r} not found")
                group_id = row[0]

            conn.execute(text("""
                INSERT INTO local_chants
                    (local_chant_id, chant_group_id, version, incipit, office_part, mode,
                     gabc, transcriber, translation_source_code, source_citation, is_text_exact,
                     derived_from_uid, status, commentary)
                VALUES
                    (:lid, :gid, :version, :incipit, :part, :mode,
                     :gabc, :transcriber, :tsrc, :citation, :exact,
                     :derived, :status, :commentary)
            """), {
                'lid': new_id,
                'gid': group_id,
                'version': body.version or 'english',
                'incipit': incipit,
                'part': office_part,
                'mode': mode_val,
                'gabc': gabc,
                'transcriber': transcriber,
                'tsrc': body.translation_source_code or None,
                'citation': body.source_citation or None,
                'exact': body.is_text_exact,
                'derived': body.derived_from_uid or None,
                'status': body.status or 'draft',
                'commentary': commentary,
            })
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, str(exc))

    return NewLocalChantResponse(
        local_chant_id=new_id,
        chant_group_id=group_id,
        incipit=incipit,
        mode=mode_val,
        version=body.version or 'english',
        status=body.status or 'draft',
    )


# ── Dashboard coverage ────────────────────────────────────────────────────────

# Sundays-and-Solemnities rank set: a closed liturgical set defined by the
# Roman Rite's Table of Liturgical Days (GILH/GIRM precedence).  These are all
# ranks whose sort_order ≤ 60 in p_lit_rank EXCEPT PROPER_SOLEMNITY (which is
# a parish/diocese-specific rank not present in the universal proper).  We
# enumerate them explicitly rather than relying on the sort_order threshold so
# that future rank insertions don't silently change scope semantics.
_SS_RANK_CODES = frozenset({
    'TRIDUUM',
    'PRINCIPAL_TEMPORAL',
    'SOLEMNITY',
    'FEAST_OF_THE_LORD',
    'SUNDAY',
})


def _dashboard_coverage(scope: str):
    """
    Compute per-source and chants-set coverage across the liturgical year.

    Coverage logic (ancestor roll-up):
      A lit_part_sources row at epoch E is *applicable* to leaf epoch L iff:
        - E == L  (direct), OR
        - E is a strict ancestor of L in lit_epoch_tree (transitively)
      AND in either case:  lps.wkday IS NULL  OR  lps.wkday == L.seq
      (L.seq holds the intra-week position 1=Sun…7=Sat for day-kind epochs;
       saint/mass epochs have no seq so only wkday-NULL rows apply to them.)

    Sunday propers in the Graduale Romanum are stored at the WEEK-level slug
    (e.g. OT-OT-03) with wkday IS NULL.  Without ancestor roll-up, Sunday
    coverage would be badly undercounted.

    Caveat: L.seq only means "day of week" when L and its tree-siblings form
    a genuine <=7-day week. A few date-anchored day ranges reuse the same
    `seq` column for a within-range date offset instead (e.g. ADV-II's "in
    ultimis feriis", Dec 17-24 = 8 dated days, seq 1..8 -- an 8th value no
    real day-of-week can take). For those, `lps.wkday == L.seq` is comparing
    two unrelated axes, so it's disabled per _seq_is_weekday() below.
    """
    with ro().connect() as conn:
        # ── 1. Load epochs ────────────────────────────────────────────────────
        epoch_rows = conn.execute(text(
            "SELECT slug, kind, rank_code, seq FROM lit_epoch"
        )).fetchall()
        epochs = {r.slug: dict(kind=r.kind, rank_code=r.rank_code, seq=r.seq)
                  for r in epoch_rows}

        # ── 2. Load adjacency list (parent → [children]) ──────────────────────
        tree_rows = conn.execute(text(
            "SELECT parent_slug, child_slug FROM lit_epoch_tree"
        )).fetchall()
        children_of: dict[str, list[str]] = {}
        parents_of: dict[str, list[str]] = {}
        for r in tree_rows:
            children_of.setdefault(r.parent_slug, []).append(r.child_slug)
            parents_of.setdefault(r.child_slug, []).append(r.parent_slug)

        # ── 3. Build ancestor sets for every epoch (BFS up the tree) ─────────
        def ancestors(slug: str) -> set[str]:
            result: set[str] = set()
            queue = list(parents_of.get(slug, []))
            while queue:
                p = queue.pop()
                if p not in result:
                    result.add(p)
                    queue.extend(parents_of.get(p, []))
            return result

        epoch_ancestors: dict[str, set[str]] = {
            slug: ancestors(slug) for slug in epochs
        }

        # A leaf's own `seq` is only a valid day-of-week (1=Sun..7=Sat) proxy
        # when it and its tree-siblings form a genuine <=7-day week. Some
        # date-anchored day ranges (e.g. ADV-II, Dec 17-24) reuse `seq` for a
        # within-range date offset instead, which can exceed 7 -- a value no
        # real day-of-week can take. Detect those groups by that impossible
        # value rather than hardcoding slugs, so any future date-anchored
        # range gets the same treatment automatically.
        def _seq_is_weekday(leaf_slug: str) -> bool:
            for parent in parents_of.get(leaf_slug, []):
                sibling_seqs = [
                    epochs[c]['seq'] for c in children_of.get(parent, [])
                    if c in epochs and epochs[c]['kind'] == 'day' and epochs[c]['seq'] is not None
                ]
                if sibling_seqs and max(sibling_seqs) > 7:
                    return False
            return True

        leaf_seq_is_weekday: dict[str, bool] = {
            slug: _seq_is_weekday(slug) for slug in epochs
        }

        # ── 4. Identify leaf epochs (no children in tree) ────────────────────
        leaf_slugs = [s for s in epochs if s not in children_of]

        # ── 5. Load service_part rows (ordered by display_order) ─────────────
        part_rows = conn.execute(text(
            "SELECT part_id, part_code, display_name, display_order, is_required"
            " FROM service_part ORDER BY display_order"
        )).fetchall()
        parts = [dict(part_id=r.part_id, part_code=r.part_code,
                      display_name=r.display_name,
                      display_order=r.display_order,
                      is_required=bool(r.is_required))
                 for r in part_rows]
        part_id_to_info = {p['part_id']: p for p in parts}

        # ── 6. Load all lps rows (small dataset) ─────────────────────────────
        lps_rows = conn.execute(text(
            "SELECT lit_epoch_slug, part_id, wkday,"
            " COALESCE(book, assignment_authority_code) AS source,"
            " chant_uuid"
            " FROM lit_part_sources"
            " WHERE lit_epoch_slug IS NOT NULL"
        )).fetchall()

        # Group by epoch slug for fast lookup:
        #   lps_by_epoch[slug] = list of {part_id, wkday, source, chant_uuid}
        lps_by_epoch: dict[str, list[dict]] = {}
        for r in lps_rows:
            lps_by_epoch.setdefault(r.lit_epoch_slug, []).append(
                dict(part_id=r.part_id, wkday=r.wkday,
                     source=r.source, chant_uuid=r.chant_uuid)
            )

        # ── 7. Preload local-chant resolution data ────────────────────────────
        # chants_set tracks epochs where the assigned chant's group has a
        # local_chants row (i.e. an in-house English GABC chant exists).
        #
        # Resolution: chant_uuid → chant_group_id via v_chant_item (handles
        # both 'gregobase:<id>' and future 'local:<uuid>' formats uniformly).
        local_chant_groups: set[int] = {
            r[0] for r in conn.execute(text(
                "SELECT DISTINCT chant_group_id FROM local_chants"
            )).fetchall()
        }
        # Map every chant_uuid that appears in lps to its chant_group_id
        uuid_to_group: dict[str, int] = {
            r.chant_item_uid: r.chant_group_id
            for r in conn.execute(text(
                "SELECT DISTINCT vci.chant_item_uid, vci.chant_group_id"
                " FROM v_chant_item vci"
                " JOIN lit_part_sources lps"
                "   ON lps.chant_uuid = vci.chant_item_uid"
                " WHERE lps.chant_uuid IS NOT NULL"
            )).fetchall()
        }

        # ── 8. Load proper_of_saints for S&S saint filter ─────────────────────
        saint_rank_rows = conn.execute(text(
            "SELECT slug, rank_code FROM proper_of_saints"
        )).fetchall()
        saint_rank = {r.slug: r.rank_code for r in saint_rank_rows}

        # ── 9. Build distinct kind list for scopes (from leaf epochs) ─────────
        leaf_kinds = sorted({epochs[s]['kind'] for s in leaf_slugs})

        # ── 10. Build scopes list ─────────────────────────────────────────────
        scope_all_count = len(leaf_slugs)

        # Sundays-and-Solemnities: day-kind with rank in _SS_RANK_CODES,
        # plus saint-kind whose proper_of_saints.rank_code == 'SOLEMNITY'
        ss_slugs = [
            s for s in leaf_slugs
            if (epochs[s]['kind'] == 'day'
                and epochs[s]['rank_code'] in _SS_RANK_CODES)
            or (epochs[s]['kind'] == 'saint'
                and saint_rank.get(s) == 'SOLEMNITY')
        ]

        scopes_meta = [
            {'id': 'all', 'label': 'All days', 'epoch_count': scope_all_count},
        ] + [
            {'id': f'kind:{k}', 'label': k.capitalize(),
             'epoch_count': sum(1 for s in leaf_slugs if epochs[s]['kind'] == k)}
            for k in leaf_kinds
        ] + [
            {'id': 'sundays-solemnities', 'label': 'Sundays & Solemnities',
             'epoch_count': len(ss_slugs)},
        ]

        # ── 11. Determine in-scope leaf slugs for requested scope ────────────
        if scope == 'all':
            scope_slugs = leaf_slugs
        elif scope == 'sundays-solemnities':
            scope_slugs = ss_slugs
        elif scope.startswith('kind:'):
            k = scope[5:]
            scope_slugs = [s for s in leaf_slugs if epochs[s]['kind'] == k]
        else:
            scope_slugs = leaf_slugs  # default fallback

        # ── 12. For each in-scope epoch, find applicable lps rows ────────────
        # Applicable: the lps row's epoch == leaf OR is an ancestor of leaf,
        # AND (lps.wkday IS NULL OR lps.wkday == leaf.seq)
        # seq may be None for saint/mass; in that case only wkday-NULL applies.
        # When leaf.seq isn't a real day-of-week (see leaf_seq_is_weekday /
        # _seq_is_weekday above), every wkday variant counts as applicable --
        # coverage can't pin down which weekday-variant a given date will
        # need without a real calendar year, so the non-undercounting answer
        # is "any of them satisfies the part".
        def applicable_lps(leaf_slug: str) -> list[dict]:
            leaf_seq = epochs[leaf_slug]['seq']
            seq_is_weekday = leaf_seq_is_weekday[leaf_slug]
            relevant_slugs = {leaf_slug} | epoch_ancestors[leaf_slug]
            result = []
            for eslug in relevant_slugs:
                for row in lps_by_epoch.get(eslug, []):
                    wd = row['wkday']
                    if wd is None or not seq_is_weekday or wd == leaf_seq:
                        result.append(row)
            return result

        # ── 13. Aggregate coverage ────────────────────────────────────────────
        # For each (epoch, part_id, source): covered? chant_set?
        # We track per-epoch the set of sources covering each part,
        # and whether the assigned chant resolves to a local_chants group.

        # source_coverage[source][part_id] = set of epoch slugs covered
        from collections import defaultdict
        source_coverage: dict[str, dict[int, set]] = defaultdict(lambda: defaultdict(set))
        # chant_coverage: part_id → set of epoch slugs where the assigned
        # chant's group has a local_chants row (in-house English GABC chant)
        chant_coverage: dict[int, set] = defaultdict(set)
        # optional part denominator: part_id → set of epochs where anyone covers it
        optional_denom: dict[int, set] = defaultdict(set)

        for slug in scope_slugs:
            rows_for_epoch = applicable_lps(slug)
            seen_parts: set[int] = set()
            for row in rows_for_epoch:
                pid = row['part_id']
                seen_parts.add(pid)
                source_coverage[row['source']][pid].add(slug)
                optional_denom[pid].add(slug)
                cuuid = row['chant_uuid']
                if cuuid:
                    grp = uuid_to_group.get(cuuid)
                    if grp is not None and grp in local_chant_groups:
                        chant_coverage[pid].add(slug)

        # ── 14. Build per-part denominators ──────────────────────────────────
        scope_size = len(scope_slugs)
        part_denominator: dict[int, int] = {}
        for p in parts:
            pid = p['part_id']
            if p['is_required']:
                denom = scope_size
            else:
                denom = len(optional_denom.get(pid, set()))
            part_denominator[pid] = denom

        # ── 15. Build response parts lists ────────────────────────────────────
        def build_parts_list(covered_by_pid: dict[int, set]) -> list[dict]:
            out = []
            for p in parts:
                pid = p['part_id']
                denom = part_denominator[pid]
                if denom == 0:
                    continue  # no data → skip bar
                cov = len(covered_by_pid.get(pid, set()))
                out.append({
                    'part_code': p['part_code'],
                    'display_name': p['display_name'],
                    'covered': cov,
                    'expected': denom,
                    'pct': round(100 * cov / denom, 1) if denom else 0.0,
                })
            return out

        # Enumerate sources from data (all sources present in any lps row in scope)
        all_sources_in_scope: set[str] = set()
        for slug in scope_slugs:
            for row in applicable_lps(slug):
                all_sources_in_scope.add(row['source'])
        # Also include sources that have data somewhere even if zero covered in scope
        all_sources_in_scope |= set(source_coverage.keys())

        sources_out = []
        for src in sorted(all_sources_in_scope):
            src_parts = build_parts_list(source_coverage.get(src, {}))
            # Only include source if it contributes at least one non-empty bar
            if any(p['expected'] > 0 for p in src_parts):
                total_cov = sum(p['covered'] for p in src_parts)
                sources_out.append({
                    'source': src,
                    'total_covered': total_cov,
                    'parts': src_parts,
                })
        # Order by total coverage desc
        sources_out.sort(key=lambda s: -s['total_covered'])
        for s in sources_out:
            del s['total_covered']  # internal sorting key only

        chants_parts = build_parts_list(chant_coverage)

        return {
            'scope': scope,
            'scopes': scopes_meta,
            'sources': sources_out,
            'chants_set': {'parts': chants_parts},
        }


@app.get("/api/dashboard/coverage")
def api_dashboard_coverage(scope: str = Query(default='all')):
    try:
        return _dashboard_coverage(scope)
    except Exception as exc:
        raise HTTPException(503, str(exc))


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

@app.get("/gr-index")
def gr_index_page():
    return FileResponse(os.path.join(_STATIC_DIR, "gr-index.html"))

@app.get("/dashboard")
def dashboard_page():
    return FileResponse(os.path.join(_STATIC_DIR, "dashboard.html"))

@app.get("/day")
def day_page():
    return FileResponse(os.path.join(_STATIC_DIR, "day.html"))

app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")
