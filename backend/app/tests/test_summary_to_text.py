"""Tests for embeddings._summary_to_text.

This turns a stored summary into the text that gets embedded for search.
It had two defects that made Ask worse without failing loudly:

  * Sections hit a catch-all `dict` branch and were embedded as raw JSON
    -- block ids, types and colours included -- so the vectors described
    the storage format rather than what was said in the meeting.
  * Rows written by the local path are double-encoded JSON, which decoded
    to a `str` and fell through to embedding the escaped blob whole.

Both are silent: you get worse search results, not an error.
"""

from __future__ import annotations

import json

from app.embeddings import _summary_to_text

SECTION = {
    "title": "Key Decisions",
    "blocks": [
        {"id": "kd-1", "type": "bullet", "color": "default",
         "content": "Decided to ship Friday"},
        {"id": "kd-2", "type": "bullet", "color": "default",
         "content": "Agreed to defer the Denver hire"},
    ],
}


def test_emits_block_prose_not_json():
    out = _summary_to_text(json.dumps({"KeyItemsDecisions": SECTION}))
    assert "Decided to ship Friday" in out
    assert "Agreed to defer the Denver hire" in out
    # The storage mechanics must not reach the embedding.
    for noise in ('"id"', "kd-1", '"type"', "bullet", '"color"', "default"):
        assert noise not in out, f"{noise!r} leaked into the embedded text"


def test_uses_the_display_title_as_a_heading():
    out = _summary_to_text(json.dumps({"KeyItemsDecisions": SECTION}))
    assert out.splitlines()[0] == "Key Decisions"


def test_unwraps_double_encoded_rows():
    # The local summarize path json.dumps() before update_process dumps
    # again. Those rows decode to a string, not a dict.
    inner = json.dumps({"KeyItemsDecisions": SECTION})
    out = _summary_to_text(json.dumps(inner))
    assert "Decided to ship Friday" in out
    assert "\\" not in out, "double-encoded row was embedded as an escaped blob"


def test_single_and_double_encoded_agree():
    single = json.dumps({"KeyItemsDecisions": SECTION})
    assert _summary_to_text(single) == _summary_to_text(json.dumps(single))


def test_meeting_name_is_kept_as_a_scalar():
    out = _summary_to_text(json.dumps({
        "MeetingName": "Q3 Pricing Review",
        "KeyItemsDecisions": SECTION,
    }))
    assert "Q3 Pricing Review" in out


def test_empty_sections_are_skipped():
    out = _summary_to_text(json.dumps({
        "KeyItemsDecisions": SECTION,
        "ClosingRemarks": {"title": "Closing Remarks", "blocks": []},
    }))
    assert "Closing Remarks" not in out


def test_accepts_the_legacy_list_of_sections():
    # Older cloud rows were stored before normalization existed.
    out = _summary_to_text(json.dumps([SECTION]))
    assert "Decided to ship Friday" in out


def test_blank_and_unparseable_input_do_not_raise():
    assert _summary_to_text("") == ""
    assert _summary_to_text("not json") == "not json"


def test_blocks_given_as_bare_strings():
    out = _summary_to_text(json.dumps({
        "NextSteps": {"title": "Next Steps", "blocks": ["reconvene Thursday"]},
    }))
    assert "reconvene Thursday" in out


def test_whitespace_only_blocks_are_dropped():
    out = _summary_to_text(json.dumps({
        "NextSteps": {"title": "Next Steps", "blocks": [
            {"content": "   "}, {"content": "real item"},
        ]},
    }))
    assert "real item" in out
    assert out.count("-") == 1, "a blank block should not produce a bullet"
