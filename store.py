"""
Lightweight persistence layer for away status.

Each row is keyed by (guild_id, user_id) so the same bot instance can serve
many different Discord servers ("guilds") at once, each with its own set of
users who've turned away-mode on. This is what makes the bot multi-tenant —
one deployment, many customers/servers.
"""

import os
import sqlite3
from contextlib import contextmanager
from typing import Optional, List, Tuple

DB_PATH = os.environ.get("DB_PATH", "away_bot.db")


@contextmanager
def _connect():
    conn = sqlite3.connect(DB_PATH)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS away_status (
                guild_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                is_away INTEGER NOT NULL DEFAULT 0,
                persona_name TEXT,
                PRIMARY KEY (guild_id, user_id)
            )
            """
        )


def set_away(guild_id: int, user_id: int, away: bool, persona_name: Optional[str] = None) -> None:
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO away_status (guild_id, user_id, is_away, persona_name)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(guild_id, user_id) DO UPDATE SET
                is_away = excluded.is_away,
                persona_name = COALESCE(excluded.persona_name, away_status.persona_name)
            """,
            (guild_id, user_id, int(away), persona_name),
        )


def is_away(guild_id: int, user_id: int) -> bool:
    with _connect() as conn:
        row = conn.execute(
            "SELECT is_away FROM away_status WHERE guild_id = ? AND user_id = ?",
            (guild_id, user_id),
        ).fetchone()
    return bool(row and row[0])


def get_persona_name(guild_id: int, user_id: int) -> Optional[str]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT persona_name FROM away_status WHERE guild_id = ? AND user_id = ?",
            (guild_id, user_id),
        ).fetchone()
    return row[0] if row else None


def list_away(guild_id: int) -> List[Tuple[int, Optional[str]]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT user_id, persona_name FROM away_status WHERE guild_id = ? AND is_away = 1",
            (guild_id,),
        ).fetchall()
    return rows
