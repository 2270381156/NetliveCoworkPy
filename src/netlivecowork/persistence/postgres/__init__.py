"""Postgres/SQLite persistence layer."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

from netlivecowork.config import get_settings
from netlivecowork.persistence.postgres.models import Base

_PROJECT_ROOT = Path(__file__).parents[4]


def _default_sqlite_path() -> Path:
    data_dir = get_settings().data_dir
    base = Path(data_dir) if data_dir else _PROJECT_ROOT / "data"
    return base / "ipmc-dev.db"


def resolve_db_url(url: str) -> str:
    """Normalize shorthand DB URLs to full SQLAlchemy async driver URLs.

    Examples:
      "sqlite"                         → sqlite+aiosqlite:///<NLC_DATA_DIR>/ipmc-dev.db
      "sqlite:///./foo.db"             → sqlite+aiosqlite:///./foo.db
      "postgresql://user:pw@host/db"   → postgresql+asyncpg://user:pw@host/db
    """
    if url in ("sqlite", "sqlite://"):
        db_path = _default_sqlite_path()
        return f"sqlite+aiosqlite:///{db_path.as_posix()}"
    if url.startswith("sqlite:///") and "+aiosqlite" not in url:
        return url.replace("sqlite:///", "sqlite+aiosqlite:///", 1)
    if url.startswith("postgresql://") and "+asyncpg" not in url:
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


def _ensure_sqlite_parent(url: str) -> None:
    """Create the parent dir for a SQLite file URL (SQLite won't create it)."""
    if "sqlite" not in url:
        return
    parts = url.split(":///", 1)
    if len(parts) != 2 or not parts[1] or ":memory:" in parts[1]:
        return
    Path(parts[1]).parent.mkdir(parents=True, exist_ok=True)


def _make_engine(url: str) -> AsyncEngine:
    """Create an async engine with SQLite-specific tuning when needed."""
    if "sqlite" in url:
        _ensure_sqlite_parent(url)
        # pool_size=1 / max_overflow=0: only one DB connection at a time.
        # All concurrent async tasks queue up for that single connection via the
        # async pool, eliminating concurrent-writer "database is locked" errors.
        # connect_args timeout=30: SQLite busy-wait fallback in case two
        # connections somehow overlap (e.g. during engine startup).
        return create_async_engine(
            url,
            echo=False,
            pool_size=1,
            max_overflow=0,
            pool_timeout=60,
            connect_args={"check_same_thread": False, "timeout": 30},
        )
    return create_async_engine(url, echo=False)


async def _apply_sqlite_pragmas(engine: AsyncEngine) -> None:
    """Set WAL mode + other pragmas on the single SQLite connection."""
    async with engine.begin() as conn:
        await conn.execute(text("PRAGMA journal_mode=WAL"))
        await conn.execute(text("PRAGMA synchronous=NORMAL"))
        await conn.execute(text("PRAGMA foreign_keys=ON"))


async def create_tables(engine: AsyncEngine) -> None:
    """Create all tables (idempotent)."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


def create_session_factory(database_url: str) -> async_sessionmaker:
    """Create an async session factory from a database URL."""
    engine = _make_engine(database_url)
    return async_sessionmaker(engine, expire_on_commit=False)


async def init_db(database_url: str) -> async_sessionmaker:
    """Resolve URL, create tables, return session factory — one call to set up everything."""
    url = resolve_db_url(database_url)
    engine = _make_engine(url)
    if "sqlite" in url:
        await _apply_sqlite_pragmas(engine)
    await create_tables(engine)
    return async_sessionmaker(engine, expire_on_commit=False)
