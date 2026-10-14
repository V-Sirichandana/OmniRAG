"""Focused row-compatibility test for the PostgreSQL branch of app.db.

Run from the backend/ directory:

    python tests/test_db_rows.py

Reloads ``app.db`` with a PostgreSQL-shaped ``DATABASE_URL`` so the ``if PG:``
row adapter (``_Row`` / ``_row_factory``) is defined, exercises it against the
sqlite3.Row contract the application relies on, then *always* restores the
original configuration and module state (context-manager ``finally``), even
when an assertion fails.

Safety: this test never opens a database connection (SQLite or PostgreSQL),
never calls ``db.db()`` / ``db.init()`` / ``db.seed_departments()``, and
never reads or modifies database data. The psycopg cursor protocol is
simulated with a fake object exposing only ``description``; the temp data
directory keeps file side effects away from the real backend/data tree.

NOT a live-PostgreSQL integration test: passing here does not prove anything
about a real PostgreSQL server connection.
"""
import contextlib
import importlib
import inspect
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Point config's file side effects at a throwaway directory BEFORE the app is
# imported, so nothing under backend/data is ever touched by this test.
os.environ["OMNIRAG_DATA_DIR"] = tempfile.mkdtemp(prefix="omnirag_row_test_")
os.environ.setdefault("JWT_SECRET", "row-test-0123456789abcdef0123456789abcdef")

import app.config as config  # noqa: E402  (path/env must be set first)
import app.db as db  # noqa: E402

_FAKE_URL = "postgresql://row-factory-check.invalid/omnirag"


@contextlib.contextmanager
def _pg_branch():
    """Reload app.db with a PG DATABASE_URL; always restore afterwards.

    Restoration runs even if the body raises (including failed assertions):
    the original config value is put back first, then app.db is reloaded so
    the module state matches the original configuration again (leftover
    PG-only names are dropped when the original configuration is SQLite).
    """
    original_url = config.DATABASE_URL
    was_pg = original_url.startswith(("postgres://", "postgresql://"))
    try:
        config.DATABASE_URL = _FAKE_URL
        importlib.reload(db)
        yield db
    finally:
        config.DATABASE_URL = original_url
        importlib.reload(db)
        if not was_pg:
            # reload() keeps names that were not re-executed; drop the ones
            # that only exist on the PG branch so state matches pre-test.
            db.__dict__.pop("_Row", None)
            db.__dict__.pop("_row_factory", None)


def _fake_cursor(columns):
    """Stand-in for a psycopg cursor exposing only what _row_factory reads."""
    return types.SimpleNamespace(
        description=[types.SimpleNamespace(name=c) for c in columns]
    )


_COLS = (
    "id", "username", "role", "tenant_id",
    "department", "employee_id", "is_manager", "tenant_name",
)
_VALS = (
    "0" * 32, "alice", "admin", "1" * 32,
    "General", "ORG-ADMIN", "0", "Acme Corporation",
)


class TestPGRowAdapter(unittest.TestCase):
    def test_pg_branch_defines_adapter(self):
        with _pg_branch() as m:
            self.assertTrue(m.PG)
            self.assertTrue(hasattr(m, "_Row"))
            self.assertTrue(hasattr(m, "_row_factory"))

    def test_row_operations_match_sqlite_contract(self):
        with _pg_branch() as m:
            maker = m._row_factory(_fake_cursor(_COLS))
            row = maker(_VALS)

            # string-key access (the pattern used throughout the app)
            self.assertEqual(row["username"], "alice")
            self.assertEqual(row["tenant_name"], "Acme Corporation")
            # positional access (rag.py / db.py use r[i])
            self.assertEqual(row[0], _VALS[0])
            self.assertEqual(row[4], _VALS[4])
            # mapping protocol
            self.assertEqual(dict(row), dict(zip(_COLS, _VALS)))
            # key listing, length, iteration (yields values, like sqlite3.Row)
            self.assertEqual(list(row.keys()), list(_COLS))
            self.assertEqual(len(row), len(_VALS))
            self.assertEqual(list(row), list(_VALS))
            self.assertTrue(all(row[k] == v for k, v in zip(_COLS, _VALS)))
            # unknown column raises KeyError, not TypeError/IndexError
            with self.assertRaises(KeyError):
                row["no_such_column"]

    def test_factory_follows_psycopg_rowfactory_protocol(self):
        with _pg_branch() as m:
            # factory(cursor) must accept exactly one positional argument:
            # this is the contract in psycopg 3.1, 3.2 and 3.3 alike.
            inspect.signature(m._row_factory).bind(_fake_cursor(("id",)))

            maker = m._row_factory(_fake_cursor(("id", "name")))
            self.assertTrue(callable(maker))
            row = maker(("0" * 32, "bob"))
            self.assertIsInstance(row, m._Row)
            self.assertEqual(dict(row), {"id": "0" * 32, "name": "bob"})

            # no-result cursors (description None or empty) still yield a maker
            self.assertTrue(callable(
                m._row_factory(types.SimpleNamespace(description=None))))
            self.assertTrue(callable(
                m._row_factory(types.SimpleNamespace(description=()))))

    def test_state_restored_after_context(self):
        original_url = config.DATABASE_URL
        with _pg_branch() as m:
            self.assertEqual(config.DATABASE_URL, _FAKE_URL)
            self.assertTrue(m.PG)
        # configuration and module state are back to their pre-test values
        self.assertEqual(config.DATABASE_URL, original_url)
        self.assertEqual(
            db.PG, original_url.startswith(("postgres://", "postgresql://")))
        # PG-only names must not linger when the original config is SQLite
        self.assertEqual(hasattr(db, "_Row"), db.PG)
        self.assertEqual(hasattr(db, "_row_factory"), db.PG)

    def test_state_restored_even_when_assertion_fails(self):
        original_url = config.DATABASE_URL
        with self.assertRaises(AssertionError):
            with _pg_branch():
                raise AssertionError("simulated failure inside PG branch")
        self.assertEqual(config.DATABASE_URL, original_url)
        self.assertEqual(
            db.PG, original_url.startswith(("postgres://", "postgresql://")))
        self.assertEqual(hasattr(db, "_Row"), db.PG)


if __name__ == "__main__":
    unittest.main(verbosity=2)
