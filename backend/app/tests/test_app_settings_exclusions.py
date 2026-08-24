"""Tests for auto-record exclusions on the /settings path.

The first implementation added the field only to /settings/recording.
The Settings page reads and writes /settings, a different endpoint with
a different model, so Pydantic silently dropped the field: typing a
pattern appeared to work, and it was gone on the next visit. Nothing
errored, which is why it reached a release.

These exercise the path the Settings page actually uses.
"""

from __future__ import annotations

import pytest

from app.db import DatabaseManager, _split_exclusions


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)          # paths.user_data_dir() == cwd in dev
    return DatabaseManager()


@pytest.mark.asyncio
async def test_round_trips_through_the_settings_endpoint_path(db):
    out = await db.update_app_settings(auto_record_exclusions=["localhost"])
    assert out["auto_record_exclusions"] == ["localhost"]
    assert (await db.get_app_settings())["auto_record_exclusions"] == ["localhost"]


@pytest.mark.asyncio
async def test_unrelated_updates_leave_exclusions_alone(db):
    await db.update_app_settings(auto_record_exclusions=["localhost"])
    await db.update_app_settings(theme="dark")
    assert (await db.get_app_settings())["auto_record_exclusions"] == ["localhost"]


@pytest.mark.asyncio
async def test_blank_patterns_are_discarded(db):
    # An empty pattern is a substring of every window title and would
    # switch auto-record off entirely.
    out = await db.update_app_settings(
        auto_record_exclusions=["", "   ", "localhost", "  spaced  "]
    )
    assert out["auto_record_exclusions"] == ["localhost", "spaced"]


@pytest.mark.asyncio
async def test_can_be_cleared(db):
    await db.update_app_settings(auto_record_exclusions=["localhost"])
    out = await db.update_app_settings(auto_record_exclusions=[])
    assert out["auto_record_exclusions"] == []


@pytest.mark.asyncio
async def test_default_is_empty_for_a_fresh_install(db):
    assert (await db.get_app_settings())["auto_record_exclusions"] == []


def test_split_helper_trims_dedupes_and_drops_blanks():
    assert _split_exclusions("localhost\n  Localhost \n\n  \nMy App") == [
        "localhost",
        "My App",
    ]
    assert _split_exclusions(None) == []
    assert _split_exclusions("") == []
