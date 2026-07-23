# Auto-Name Recordings by Topic — Design

**Status:** Approved (design)
**Date:** 2026-07-23
**Depends on:** cloud summarize path (`backend/app/main.py` `_cloud_summarize_bg`), existing local-path auto-rename (main.py ~1093), `/save-meeting-title`.

## Goal

When a recording's summary completes, rename the recording to the meeting's
primary topic — reliably, for both auto-detected and manual recordings, old
and new — without ever overwriting a title the user has edited. The user can
still rename freely, and a manual rename is never auto-overwritten.

## Behavior

After a summary completes, take the summary's `MeetingName` (a 4–7 word topic
the model already generates). Rename the meeting **only when the current title
is still an auto-generated placeholder**:

- `Auto: <app> · <date>` (auto-detected recordings), or
- `Recording <date>` (manual recordings).

Any other title means the user renamed it → **leave it untouched**. Skip the
model's `"Untitled meeting"` sentinel (too short/silent to title) so the
placeholder stays rather than becoming that literal phrase.

Because the rule keys off the *current* title, re-summarizing an **old**
placeholder-titled recording renames it too (retroactive, by construction).

Always on — no setting (per product decision).

## Components

### C1. Reliable `MeetingName` extraction (backend)

The proxy summary is a list of `{title, blocks}` sections. Extract the name:

1. A section literally titled `MeetingName` → its first block's `content`.
2. Else, if a section's title is **not** one of the fixed content-section
   names (`SectionSummary`, `CriticalDeadlines`, `KeyItemsDecisions`,
   `ImmediateActionItems`, `NextSteps`, `OtherImportantPoints`,
   `ClosingRemarks`), the model put the topic in the title itself (the observed
   bug) → use that title (or its block content) as the name, and do **not**
   render it as a content section.
3. Else → no name (leave the placeholder).

Result: `summary_dict["MeetingName"]` is always a clean string (or absent), and
the stray "meeting name as a section" no longer appears in the summary body.

### C2. Server-side rename (backend)

In `_cloud_summarize_bg`, after the summary is stored, if `MeetingName` is a
real topic, read the current title (`db.get_meeting_title`) and, when it starts
with `"Auto: "` or `"Recording "`, call `db.update_meeting_name`. Log the
rename. Mirror the same broadened placeholder check in the existing local-path
rename (main.py ~1104) so both paths behave identically. Rename failures are
caught and logged; they never fail the summary.

### C3. Instant UI reflection + editing (frontend)

The summary poll handlers already apply `MeetingName` to the displayed title
when it's a placeholder — broaden their `startsWith('Auto: ')` guard to also
match `startsWith('Recording ')` (page.tsx ×2, page-content.tsx ×2). This shows
the new name immediately without a refresh. Editing is unchanged: the existing
`EditableTitle` → `/save-meeting-title` flow renames, and the placeholder rule
guarantees no auto-overwrite afterward.

## Error handling
- No usable `MeetingName` → no rename; placeholder stays.
- DB read/write failure during rename → logged, non-fatal (summary still ok).

## Testing
- Unit: name extraction from a list — the `MeetingName`-section case, the
  name-as-title case, and the no-name case.
- Unit: placeholder rule — renames `Auto: …` and `Recording …`, preserves an
  edited title, skips `Untitled meeting`.
- Manual E2E: record → summary → title becomes the topic; rename manually →
  re-summarize → title preserved; re-summarize an old `Recording <date>` → it
  renames.

## Out of scope
- A settings toggle (decided always-on).
- Renaming purely from the transcript without a summary.
