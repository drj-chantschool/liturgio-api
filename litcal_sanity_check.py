"""Sanity-check our /api/day calendar against the Liturgical Calendar API.

A cross-check, not a reference: the Liturgical Calendar API
(https://github.com/Liturgical-Calendar/LiturgicalCalendarAPI, cloned under
vendor/LiturgicalCalendarAPI for reading its rules) is an independent
implementation of the General Roman Calendar. Where the two disagree, either
side may be wrong; each line of the report is something to look at, not a bug.

Our side is get_day() called in-process (no server, no token needed), so it
reads whatever DB app.py is configured for. Their side is fetched from the
hosted instance (or --litcal-url, e.g. a local server run from the clone, or
--litcal-json, a saved response).

Per date it compares:
  * WINNER  the day's celebrated observance has a different rank class
  * NAME    same rank class, but the titles don't fuzzy-match (often just wording;
            not reported for weekdays, whose titles are worded differently)
  * MISSING a memorial/feast they list on the date that we have no observance for
  * EXTRA   a saint we list that they don't, though the day doesn't impede it
            (we list impeded saints on purpose; they drop them)
  * RANK    a saint both list, at different rank classes
  * UNDET   a saint we list with rank UNDETERMINED (informational; --no-undet hides it)

Usage:
    python litcal_sanity_check.py                      # US, current civil year
    python litcal_sanity_check.py --year 2027 --jurisdiction UNIVERSAL
    python litcal_sanity_check.py --from 2026-03-01 --to 2026-04-30
"""
import argparse
import datetime
import difflib
import json
import re
import sys
import unicodedata
import urllib.request
from collections import Counter, defaultdict

import app

LITCAL_URL = 'https://litcal.johnromanodorazio.com/api/dev'

# Their `grade` scale. Ours maps onto it for comparison (UNDETERMINED: None).
GRADE_NAMES = {0: 'weekday', 1: 'commemoration', 2: 'opt. memorial', 3: 'memorial',
               4: 'feast', 5: 'feast of the Lord', 6: 'solemnity', 7: 'higher than solemnity'}
OUR_GRADE = {
    'TRIDUUM': 7, 'PRINCIPAL_TEMPORAL': 7,
    'SOLEMNITY': 6, 'PROPER_SOLEMNITY': 6,
    'FEAST_OF_THE_LORD': 5, 'SUNDAY': 5,      # they grade Sundays per annum / of Christmas 5
    'FEAST': 4, 'PROPER_FEAST': 4,
    'MEMORIAL': 3, 'PROPER_MEMORIAL': 3,
    'OPTIONAL_MEMORIAL': 2,
    'WEEKDAY': 0, 'PRIVILEGED_WEEKDAY': 0,
}

_STOP = {'saint', 'saints', 'st', 'sts', 'blessed', 'the', 'of', 'and', 'a', 'in', 'on',
         'bishop', 'bishops', 'martyr', 'martyrs', 'priest', 'priests', 'virgin', 'virgins',
         'religious', 'pope', 'abbot', 'deacon', 'doctor', 'church', 'companions', 'apostle',
         'apostles', 'evangelist', 'hermit', 'missionary', 'founder', 'monk', 'nun', 'with'}


_ORDINALS = {w: str(i) for i, w in enumerate(
    'first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth'.split(), 1)}


def _tokens(title: str) -> set:
    s = re.sub(r'^\[ *\w+ *\]\s*', '', title)      # "[ US ] Saint ..."
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    words = (_ORDINALS.get(w, re.sub(r'^(\d+)(st|nd|rd|th)$', r'\g<1>', w))
             for w in re.findall(r'[a-z0-9]+', s))
    return {w for w in words if w not in _STOP}


def same_name(ours: str, theirs: str) -> bool:
    a, b = _tokens(ours), _tokens(theirs)
    if a and b and (a <= b or b <= a):
        return True
    return difflib.SequenceMatcher(None, ' '.join(sorted(a)), ' '.join(sorted(b))).ratio() >= 0.75


def grades_agree(our_rank: str, their_grade: int) -> bool:
    g = OUR_GRADE.get(our_rank)
    if g is None:
        return True
    if their_grade == 1:              # memorial reduced to a commemoration (Lent, Dec 17-24...)
        return g in (2, 3)
    return g == their_grade


def fetch_litcal(args, year: int) -> list:
    if args.litcal_json:
        with open(args.litcal_json, encoding='utf-8') as f:
            return json.load(f)['litcal']
    path = (f'/calendar/{year}' if args.jurisdiction == 'UNIVERSAL'
            else f'/calendar/nation/{args.jurisdiction}/{year}')
    url = f'{args.litcal_url.rstrip("/")}{path}?year_type=CIVIL&locale=en_US'
    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)['litcal']


def their_events_by_date(events: list) -> dict:
    by_date = defaultdict(list)
    for e in events:
        # Vigil Masses are the eve of the next day's event; we don't model the
        # Saturday memorial of the BVM.
        if e.get('is_vigil_mass') or e['event_key'].startswith('SatMemBVM'):
            continue
        by_date[e['date'][:10]].append(e)
    return by_date


def check_date(dt: datetime.date, theirs: list, jurisdiction: str, show_undet: bool) -> list:
    """Return [(category, message), ...] for one date."""
    out = []
    try:
        day = app.get_day(dt.isoformat(), jurisdiction=jurisdiction)
    except app.HTTPException as exc:
        return [('ERROR', f'our get_day: {exc.status_code} {exc.detail}')]
    if not theirs:
        return [('ERROR', 'no events from LitCal for this date')]

    obs = day.observances
    our_win = next((o for o in obs if o.role == 'celebrated'), obs[0])
    # Optional memorials and commemorations never displace the day.
    their_win = max(theirs, key=lambda e: (e['grade'] not in (1, 2), e['grade']))

    win_name_ok = same_name(our_win.title, their_win['name'])
    pair = (f"ours {our_win.title!r} [{our_win.rank_code}]"
            f"  vs theirs {their_win['name']!r} [{GRADE_NAMES[their_win['grade']]}]")
    if not grades_agree(our_win.rank_code, their_win['grade']):
        out.append(('WINNER', pair))
    elif not win_name_ok and their_win['grade'] > 0:
        out.append(('NAME', pair))

    # Saints / non-winning celebrations, matched by name across the two lists.
    ours_rest = [o for o in obs if o is not our_win and o.epoch_slug != day.season_slug]
    theirs_rest = [e for e in theirs if e is not their_win and e['grade'] >= 1]
    hits = {}
    for o in ours_rest:
        hits[id(o)] = next((e for e in theirs_rest if e not in hits.values() and same_name(o.title, e['name'])), None)
    # One unnamed celebration left on each side: the same one, worded differently.
    left_o = [o for o in ours_rest if hits[id(o)] is None]
    left_t = [e for e in theirs_rest if e not in hits.values() and e['grade'] <= 4]
    if len(left_o) == 1 and len(left_t) == 1:
        hits[id(left_o[0])] = left_t[0]
    matched = set()
    for o in ours_rest:
        hit = hits[id(o)]
        if hit is None and not win_name_ok and same_name(o.title, their_win['name']):
            continue                     # already reported as a WINNER mismatch
        if o.rank_code == 'UNDETERMINED':
            if show_undet:
                out.append(('UNDET', f"{o.title!r} ({o.epoch_slug})"
                                     + (f" — theirs: {GRADE_NAMES[hit['grade']]}" if hit else '')))
        elif hit is None:
            if OUR_GRADE.get(o.rank_code, 0) < their_win['grade']:
                continue                 # impeded by the day: they drop it, we list it
            out.append(('EXTRA', f"{o.title!r} [{o.rank_code}, role={o.role}] ({o.epoch_slug})"))
        elif not grades_agree(o.rank_code, hit['grade']):
            out.append(('RANK', f"{o.title!r}: ours {o.rank_code}, theirs {GRADE_NAMES[hit['grade']]}"))
        if hit is not None:
            matched.add(id(hit))
    for e in theirs_rest:
        if id(e) in matched:
            continue
        if not win_name_ok and same_name(our_win.title, e['name']):
            continue
        out.append(('MISSING', f"{e['name']!r} [{GRADE_NAMES[e['grade']]}] ({e['event_key']})"))
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--year', type=int, default=datetime.date.today().year)
    p.add_argument('--from', dest='date_from', type=datetime.date.fromisoformat)
    p.add_argument('--to', dest='date_to', type=datetime.date.fromisoformat)
    p.add_argument('--jurisdiction', default='US',
                   help="our jurisdiction; LitCal nation code, or UNIVERSAL for the General Roman Calendar")
    p.add_argument('--litcal-url', default=LITCAL_URL)
    p.add_argument('--litcal-json', help='use a saved LitCal calendar response instead of fetching')
    p.add_argument('--no-undet', dest='show_undet', action='store_false',
                   help='hide UNDETERMINED-rank saints')
    args = p.parse_args()
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

    start = args.date_from or datetime.date(args.year, 1, 1)
    end = args.date_to or datetime.date(args.year, 12, 31)
    by_date = {}
    for year in range(start.year, end.year + 1):
        by_date.update(their_events_by_date(fetch_litcal(args, year)))

    counts = Counter()
    dt = start
    while dt <= end:
        for cat, msg in check_date(dt, by_date.get(dt.isoformat(), []), args.jurisdiction, args.show_undet):
            counts[cat] += 1
            print(f"{dt} {dt:%a}  {cat:<7} {msg}")
        dt += datetime.timedelta(days=1)

    print(f"\n{start}..{end} [{args.jurisdiction}]  " +
          ('  '.join(f"{k}={v}" for k, v in sorted(counts.items())) or 'no differences'))


if __name__ == '__main__':
    sys.exit(main())
