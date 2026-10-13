"""Manage liturgio-api login users (app_user / p_app_role).

Without --do, commands act on local MySQL; with --do, they act ONLY on DO (as
doadmin). Local and DO users are independent: app_user is excluded from the
local→DO refresh, so --do is the only way a user change reaches prod.

    python manage_users.py list [--do]
    python manage_users.py roles
    python manage_users.py add USERNAME --role EDITOR [--name "Full Name"] [--do]
    python manage_users.py passwd USERNAME [--do]
    python manage_users.py role USERNAME ADMIN [--do]
    python manage_users.py disable USERNAME [--do]
    python manage_users.py enable USERNAME [--do]

Passwords are prompted for (never taken on the command line). `passwd` and
`disable` bump session_epoch, which signs the user out everywhere.
"""
import argparse
import getpass
import os
import sys

import keyring
from sqlalchemy import create_engine, text

from auth import MIN_PASSWORD_LEN, hash_password

_DO_HOST = 'db-mysql-nyc3-73323-do-user-34645648-0.d.db.ondigitalocean.com'
_CA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ca-certificate.crt')


def _local():
    pw = keyring.get_password('liturgio-mysql', 'jcost')
    return create_engine(f'mysql+mysqlconnector://jcost:{pw}@localhost:3306/liturgio', future=True)


def _do():
    pw = keyring.get_password('liturgio-mysql-do', 'doadmin')
    if not pw:
        sys.exit('No keyring entry liturgio-mysql-do / doadmin')
    return create_engine(
        f'mysql+mysqlconnector://doadmin:{pw}@{_DO_HOST}:25060/liturgio',
        connect_args={'ssl_ca': _CA, 'ssl_verify_cert': True, 'ssl_verify_identity': True},
        future=True)


def _targets(args):
    return [('DO', _do())] if args.do else [('local', _local())]


def _prompt_password() -> str:
    while True:
        p1 = getpass.getpass('New password: ')
        if len(p1) < MIN_PASSWORD_LEN:
            print(f'Use at least {MIN_PASSWORD_LEN} characters.')
            continue
        if p1 != getpass.getpass('Repeat password: '):
            print('Passwords differ.')
            continue
        return p1


def _require_one(conn, username):
    n = conn.execute(text('SELECT COUNT(*) FROM app_user WHERE username = :u'),
                     {'u': username}).scalar()
    if n != 1:
        raise SystemExit(f'No user {username!r}')


def cmd_list(args):
    for name, eng in _targets(args):
        print(f'── {name}')
        with eng.connect() as conn:
            rows = conn.execute(text("""
                SELECT username, display_name, role_code, is_active, updated_at
                FROM app_user ORDER BY username""")).all()
        for r in rows:
            flag = '' if r.is_active else '  (disabled)'
            print(f'  {r.username:<20} {r.role_code:<10} {r.display_name or ""}{flag}')
        if not rows:
            print('  (no users)')


def cmd_roles(args):
    (_, eng), = _targets(args)
    with eng.connect() as conn:
        for r in conn.execute(text("""
                SELECT role_code, role_level, display_name, notes FROM p_app_role
                WHERE is_active = 1 ORDER BY role_level""")):
            print(f'  {r.role_code:<10} {r.role_level:>3}  {r.display_name} — {r.notes or ""}')


def cmd_add(args):
    role = args.role.upper()
    pw_hash = hash_password(_prompt_password())
    for name, eng in _targets(args):
        with eng.begin() as conn:
            conn.execute(text("""
                INSERT INTO app_user (username, display_name, password_hash, role_code)
                VALUES (:u, :n, :h, :r)"""),
                {'u': args.username, 'n': args.name, 'h': pw_hash, 'r': role})
        print(f'{name}: added {args.username} ({role})')


def _update(args, sql, params, label):
    for name, eng in _targets(args):
        with eng.begin() as conn:
            _require_one(conn, args.username)
            conn.execute(text(sql), {'u': args.username, **params})
        print(f'{name}: {label} {args.username}')


def cmd_passwd(args):
    _update(args, """UPDATE app_user SET password_hash = :h, session_epoch = session_epoch + 1
                     WHERE username = :u""",
            {'h': hash_password(_prompt_password())}, 'password changed for')


def cmd_role(args):
    _update(args, 'UPDATE app_user SET role_code = :r WHERE username = :u',
            {'r': args.role.upper()}, f'role {args.role.upper()} for')


def cmd_disable(args):
    _update(args, """UPDATE app_user SET is_active = 0, session_epoch = session_epoch + 1
                     WHERE username = :u""", {}, 'disabled')


def cmd_enable(args):
    _update(args, 'UPDATE app_user SET is_active = 1 WHERE username = :u', {}, 'enabled')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)

    def p(name, fn, user=True):
        sp = sub.add_parser(name)
        if user:
            sp.add_argument('username', type=str.lower)
        sp.add_argument('--do', action='store_true', help='act on DO instead of local')
        sp.set_defaults(fn=fn)
        return sp

    p('list', cmd_list, user=False)
    p('roles', cmd_roles, user=False)
    a = p('add', cmd_add)
    a.add_argument('--role', required=True)
    a.add_argument('--name')
    p('passwd', cmd_passwd)
    r = p('role', cmd_role)
    r.add_argument('role')
    p('disable', cmd_disable)
    p('enable', cmd_enable)

    args = ap.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
