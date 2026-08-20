"""Tests for gemini.normalize_summary.

The contract these lock down matters more than it looks: the desktop app
only reshapes a summary when it arrives as a list, so returning a
well-formed dict from here is what allows section changes to ship by
redeploying the proxy alone. If normalization regresses, summaries reach
users malformed and there is no client-side net to catch it.
"""

import app.gemini as g


SECTION_KEYS = [k for k, _ in g.SUMMARY_SECTIONS]


# ---------------------------------------------------------------------------
# Shape guarantees
# ---------------------------------------------------------------------------

def test_every_section_present_even_when_model_omits_them():
    out = g.normalize_summary({"MeetingName": "Q3 Review"})
    assert out["MeetingName"] == "Q3 Review"
    for key, title in g.SUMMARY_SECTIONS:
        assert out[key]["title"] == title
        assert out[key]["blocks"] == []


def test_sections_render_in_declared_order():
    # The frontend renders Object.entries() in insertion order, so this
    # ordering IS the on-screen ordering.
    out = g.normalize_summary({"ClosingRemarks": {"blocks": ["bye"]},
                               "BottomLine": {"blocks": ["the point"]}})
    keys = [k for k in out if k != "MeetingName"]
    assert keys == SECTION_KEYS
    assert keys.index("BottomLine") < keys.index("ClosingRemarks")


def test_blocks_are_well_formed():
    out = g.normalize_summary({"BottomLine": {"blocks": [{"content": "ship it"}]}})
    b = out["BottomLine"]["blocks"][0]
    assert b == {"id": "bottomline-1", "type": "bullet",
                 "content": "ship it", "color": "default"}


def test_block_ids_contain_the_section_key():
    # The frontend regenerates any id that doesn't contain its section
    # key; matching the convention keeps ids stable across renders.
    out = g.normalize_summary({"OpenQuestions": {"blocks": ["a", "b"]}})
    ids = [b["id"] for b in out["OpenQuestions"]["blocks"]]
    assert ids == ["openquestions-1", "openquestions-2"]


# ---------------------------------------------------------------------------
# Model non-determinism
# ---------------------------------------------------------------------------

def test_accepts_list_of_sections():
    raw = [
        {"title": "MeetingName", "blocks": [{"content": "Vendor Sync"}]},
        {"title": "BottomLine", "blocks": [{"content": "Renewed for a year"}]},
    ]
    out = g.normalize_summary(raw)
    assert out["MeetingName"] == "Vendor Sync"
    assert out["BottomLine"]["blocks"][0]["content"] == "Renewed for a year"


def test_topic_placed_in_a_section_title_becomes_the_meeting_name():
    # Observed behaviour: the model sometimes names the meeting by
    # inventing a section rather than filling MeetingName.
    out = g.normalize_summary([{"title": "Pricing Strategy Review", "blocks": []}])
    assert out["MeetingName"] == "Pricing Strategy Review"


def test_meeting_name_arriving_as_a_section_object():
    out = g.normalize_summary({"MeetingName": {"blocks": [{"content": "Standup"}]}})
    assert out["MeetingName"] == "Standup"


def test_bare_string_blocks_are_accepted():
    out = g.normalize_summary({"NextSteps": {"blocks": ["reconvene Thursday"]}})
    assert out["NextSteps"]["blocks"][0]["content"] == "reconvene Thursday"


def test_missing_meeting_name_falls_back_to_sentinel():
    # Six call sites treat exactly "Untitled meeting" as "don't rename".
    out = g.normalize_summary({"BottomLine": {"blocks": ["x"]}})
    assert out["MeetingName"] == "Untitled meeting"


def test_empty_and_whitespace_blocks_are_dropped():
    out = g.normalize_summary({"NextSteps": {"blocks": ["  ", "", "real", None]}})
    contents = [b["content"] for b in out["NextSteps"]["blocks"]]
    assert contents == ["real"]


def test_unknown_sections_are_discarded_not_rendered():
    out = g.normalize_summary({"MeetingName": "X", "MadeUpSection": {"blocks": ["y"]}})
    assert "MadeUpSection" not in out


def test_garbage_input_still_yields_a_valid_shape():
    for junk in [None, "text", 42, []]:
        out = g.normalize_summary(junk)
        assert out["MeetingName"] == "Untitled meeting"
        assert set(SECTION_KEYS).issubset(out)


# ---------------------------------------------------------------------------
# Action-item format (the app will render these as a table)
# ---------------------------------------------------------------------------

def test_action_item_pipe_format_survives_normalization():
    out = g.normalize_summary(
        {"ImmediateActionItems": {"blocks": ["Sarah | Send the quote | 2026-09-01"]}}
    )
    content = out["ImmediateActionItems"]["blocks"][0]["content"]
    assert content.split(" | ") == ["Sarah", "Send the quote", "2026-09-01"]
