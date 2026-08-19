import aiosqlite
import json
from datetime import datetime, timezone
from typing import Optional, Dict
import logging
from contextlib import asynccontextmanager
import sqlite3

logger = logging.getLogger(__name__)

# Phase 8 Task 2: when running as a frozen sidecar inside the MSI, the
# default DB path needs to live in %APPDATA% — Program Files is read-
# only. paths.db_path() resolves to cwd in dev (preserving today's
# behavior) and AppData in frozen builds. We compute it once at import
# so the default-arg below stays a literal string.
try:
    from paths import db_path as _resolve_db_path
    _DEFAULT_DB_PATH = _resolve_db_path()
except Exception:
    # paths.py not yet available during a partial-import edge case
    # (or a non-standard launcher) — fall back to the historical name.
    _DEFAULT_DB_PATH = "meeting_minutes.db"


class DatabaseManager:
    def __init__(self, db_path: str = ""):
        # Empty string → use the resolved default. Lets explicit
        # callers pass any path (tests, migrations); empty/missing
        # picks up the frozen-aware default.
        self.db_path = db_path or _DEFAULT_DB_PATH
        self._init_db()

    def _init_db(self):
        """Initialize the database with required tables"""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            
            # Create meetings table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS meetings (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    detection_source TEXT DEFAULT 'manual',
                    detection_confidence TEXT DEFAULT 'manual'
                )
            """)
            
            # Create transcripts table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS transcripts (
                    id TEXT PRIMARY KEY,
                    meeting_id TEXT NOT NULL,
                    transcript TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    summary TEXT,
                    action_items TEXT,
                    key_points TEXT,
                    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
                )
            """)
            
            # Create summary_processes table (keeping existing functionality)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS summary_processes (
                    meeting_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    error TEXT,
                    result TEXT,
                    start_time TEXT,
                    end_time TEXT,
                    chunk_count INTEGER DEFAULT 0,
                    processing_time REAL DEFAULT 0.0,
                    metadata TEXT,
                    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS transcript_chunks (
                    meeting_id TEXT PRIMARY KEY,
                    meeting_name TEXT,
                    transcript_text TEXT NOT NULL,
                    model TEXT NOT NULL,
                    model_name TEXT NOT NULL,
                    chunk_size INTEGER,
                    overlap INTEGER,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
                )
            """)

            # Create settings table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS settings (
                    id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    whisperModel TEXT NOT NULL,
                    groqApiKey TEXT,
                    openaiApiKey TEXT,
                    anthropicApiKey TEXT,
                    ollamaApiKey TEXT,
                    geminiApiKey TEXT,
                    auto_record_enabled INTEGER DEFAULT 1,
                    has_seen_onboarding INTEGER DEFAULT 0,
                    auto_summarize_enabled INTEGER DEFAULT 1
                )
            """)

            # Phase 3 Task 7: folders + tags + meeting<->tag junction.
            # Folders are hierarchical (parent_id self-FK, ON DELETE
            # SET NULL so deleting a parent doesn't cascade-delete its
            # children — they just become top-level).
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS folders (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            # Tags are flat. UNIQUE on lowercased name (we enforce that
            # in Python because SQLite's UNIQUE is binary-collated by
            # default; storing the user-typed casing while matching
            # case-insensitively).
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS tags (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            cursor.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_lower
                ON tags (LOWER(name))
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS meeting_tags (
                    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                    PRIMARY KEY (meeting_id, tag_id)
                )
            """)
            # Phase 8 Task 1: cost_log. One row per outbound Gemini call.
            # Lets us compute real cost-per-meeting/month for pricing,
            # surface in the /admin page, and eventually attribute to
            # users when the auth backend lands. meeting_id is nullable
            # because /ask and /enhance-prompt aren't tied to a specific
            # meeting. ON DELETE SET NULL so deleting a meeting doesn't
            # destroy its cost history (you'd lose data needed for
            # invoicing/audit).
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS cost_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    endpoint TEXT NOT NULL,
                    model TEXT NOT NULL,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    audio_seconds REAL NOT NULL DEFAULT 0,
                    cost_usd REAL NOT NULL DEFAULT 0,
                    meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
                    notes TEXT
                )
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_cost_log_ts ON cost_log(ts)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_cost_log_meeting
                ON cost_log(meeting_id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_cost_log_endpoint
                ON cost_log(endpoint)
            """)

            # Ask history: one row per question/answer exchange from the
            # /ask endpoint. Citations are stored as a JSON blob rather
            # than a join table — they're always read back whole, never
            # queried across, and freezing them keeps an old answer's
            # sources intact even if a cited meeting is later deleted.
            #
            # meeting_id is set only for "ask about this recording"
            # exchanges; ON DELETE CASCADE drops that history along with
            # its recording, since it has no meaning without it.
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS ask_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    question TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    citations TEXT NOT NULL DEFAULT '[]',
                    meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
                    scope_label TEXT,
                    pinned INTEGER NOT NULL DEFAULT 0
                )
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_ask_history_created
                ON ask_history(created_at DESC)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_ask_history_meeting
                ON ask_history(meeting_id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_ask_history_pinned
                ON ask_history(pinned)
            """)

            # Idempotent migrations for existing installs (Phase 2a/2b/3)
            self._run_migrations(cursor)

            conn.commit()

    def _run_migrations(self, cursor):
        """Idempotent column-add migrations + default settings seed.
        Safe to run on every startup."""
        # meetings.detection_source
        cursor.execute("PRAGMA table_info(meetings)")
        meeting_cols = [row[1] for row in cursor.fetchall()]
        if "detection_source" not in meeting_cols:
            cursor.execute(
                "ALTER TABLE meetings ADD COLUMN detection_source TEXT DEFAULT 'manual'"
            )
        # meetings.detection_confidence (Phase 2b)
        if "detection_confidence" not in meeting_cols:
            cursor.execute(
                "ALTER TABLE meetings ADD COLUMN detection_confidence TEXT DEFAULT 'manual'"
            )
        # Phase 3 Task 7: meetings.folder_id (nullable FK to folders).
        # ON DELETE SET NULL: deleting a folder uncategorizes its
        # meetings rather than deleting them.
        if "folder_id" not in meeting_cols:
            cursor.execute(
                "ALTER TABLE meetings ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL"
            )

        # settings.auto_record_enabled, settings.has_seen_onboarding
        cursor.execute("PRAGMA table_info(settings)")
        settings_cols = [row[1] for row in cursor.fetchall()]
        if "auto_record_enabled" not in settings_cols:
            cursor.execute(
                "ALTER TABLE settings ADD COLUMN auto_record_enabled INTEGER DEFAULT 1"
            )
        if "has_seen_onboarding" not in settings_cols:
            cursor.execute(
                "ALTER TABLE settings ADD COLUMN has_seen_onboarding INTEGER DEFAULT 0"
            )
        if "auto_summarize_enabled" not in settings_cols:
            cursor.execute(
                "ALTER TABLE settings ADD COLUMN auto_summarize_enabled INTEGER DEFAULT 1"
            )
        # Phase 4 Task 1A: gemini API key column. Existing installs
        # don't have this; add it so save_api_key("gemini", ...) works.
        if "geminiApiKey" not in settings_cols:
            cursor.execute(
                "ALTER TABLE settings ADD COLUMN geminiApiKey TEXT"
            )
        # Phase 4 Task 1B: app-level settings columns.
        # auto_record_sources is a comma-separated list of detector
        # source keys ("teams", "meet", "zoom", "webex", "discord"); the
        # detection layer skips events from sources missing from this
        # set. Default enables every shipped source except Discord.
        if "auto_record_sources" not in settings_cols:
            cursor.execute(
                "ALTER TABLE settings ADD COLUMN auto_record_sources TEXT "
                "DEFAULT 'teams,meet,zoom,webex,browser'"
            )

        # Phase 7 Task 5: backfill "browser" into existing rows that
        # were created before the toggle existed, so upgrades don't
        # silently disable the YouTube-records-when-Zoom-is-in-tray
        # behavior these users have been getting. Idempotent — only
        # rows whose csv lacks "browser" are touched.
        cursor.execute(
            "SELECT id, auto_record_sources FROM settings"
        )
        for row_id, csv in cursor.fetchall():
            keys = [k.strip().lower() for k in (csv or "").split(",") if k.strip()]
            if "browser" not in keys:
                keys.append("browser")
                cursor.execute(
                    "UPDATE settings SET auto_record_sources = ? WHERE id = ?",
                    (",".join(keys), row_id),
                )
                logger.info(
                    "[migration] Added 'browser' to settings row %s.auto_record_sources",
                    row_id,
                )
        # default_folder_id: nullable FK to folders. NULL = Uncategorized.
        # We don't add a hard FK constraint here — folders.id is stable
        # but a deleted folder shouldn't 500 the settings read; the
        # frontend treats unknown ids as Uncategorized.
        if "default_folder_id" not in settings_cols:
            cursor.execute(
                "ALTER TABLE settings ADD COLUMN default_folder_id TEXT"
            )
        # theme: 'light' | 'dark' | 'system'. Default 'system'.
        if "theme" not in settings_cols:
            cursor.execute(
                "ALTER TABLE settings ADD COLUMN theme TEXT DEFAULT 'system'"
            )

        # Phase 4 Task 1B: meetings.custom_summary_prompt — per-meeting
        # one-off prompt addendum that gets appended to the standard
        # summary prompt on the next /process-transcript call.
        if "custom_summary_prompt" not in meeting_cols:
            cursor.execute(
                "ALTER TABLE meetings ADD COLUMN custom_summary_prompt TEXT"
            )

        # Phase 4 Task 1D: saved_prompts library. CREATE IF NOT EXISTS
        # is idempotent. Starter seed runs only when the table has zero
        # rows tagged is_starter=1 — so a user who deletes a starter
        # won't see it reappear on the next launch.
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS saved_prompts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'General',
                prompt_text TEXT NOT NULL,
                is_starter INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                use_count INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        cursor.execute("SELECT COUNT(*) FROM saved_prompts WHERE is_starter = 1")
        if cursor.fetchone()[0] == 0:
            # Phase 4 Task 1D.1: expanded from 6 → 14 across 5 categories
            # (General, Sales, Internal, Hiring, Customer Success). The
            # is_starter=1 gate above means existing installs that
            # already seeded the original 6 won't see the 8 new
            # additions on next startup; an Option-A upsert snippet
            # (documented in the Task 1D.1 prompt) handles that
            # backfill surgically without disturbing existing rows.
            starters = [
                # General
                ("Action Items Only", "General",
                 "Focus exclusively on actionable items requiring follow-up. For "
                 "each action item, identify the owner if mentioned and any "
                 "deadline. Omit background discussion, pleasantries, and "
                 "general context."),
                ("Executive Summary", "General",
                 "Write a concise executive-level summary suitable for someone "
                 "who did not attend. Lead with the single most important "
                 "takeaway. Limit to 5 bullet points covering decisions made, "
                 "key risks raised, and next steps. Skip operational detail."),
                ("Decisions Log", "General",
                 "Capture only the decisions made and their rationale. For each "
                 "decision, note who proposed it, who agreed or objected, what "
                 "alternatives were considered, and any conditions or follow-up "
                 "that must happen for the decision to stick. Skip discussion "
                 "that didn't lead to a decision."),

                # Sales
                ("Discovery Call Notes", "Sales",
                 "Structure as a sales discovery call. Capture: company "
                 "background, current pain points, existing solutions in use, "
                 "decision-making process, budget signals, timeline, and next "
                 "steps. Note any explicit objections or competitive references."),
                ("Demo Recap", "Sales",
                 "Recap as a product demo. Capture: features demonstrated, "
                 "prospect reactions and questions, objections raised and how "
                 "they were handled, follow-up commitments, and stakeholders "
                 "to loop in. Note any feature requests or gaps the prospect "
                 "highlighted."),
                ("Renewal Conversation", "Sales",
                 "Format as a customer renewal review. Capture: current usage "
                 "and value realized, expansion opportunities mentioned, churn "
                 "risks or concerns raised, competitive threats referenced, "
                 "pricing or contract negotiation signals, and stakeholders "
                 "involved in the decision. Note any specific requests for "
                 "proof points or business case material."),
                ("Cold Outreach Call", "Sales",
                 "Recap as an initial outbound call. Capture: how the prospect "
                 "responded to the opening, pain points they acknowledged or "
                 "denied, qualification signals (BANT or similar), objections "
                 "to taking a follow-up meeting, and what was specifically "
                 "agreed for next steps. Note quotable language the prospect "
                 "used about their current state."),

                # Internal
                ("Standup Recap", "Internal",
                 "Format as a team standup. For each speaker, capture: what "
                 "they completed, what they are working on, and any blockers. "
                 "Group blockers separately at the end with the owner who "
                 "needs to unblock them."),
                ("1:1 Notes", "Internal",
                 "Capture as 1:1 manager/report notes. Sections: career "
                 "discussion, current project updates, blockers or concerns "
                 "raised, feedback given or received, and explicit follow-ups "
                 "for either party. Preserve the candor of the conversation."),
                ("Retrospective", "Internal",
                 "Format as an agile retrospective. Group items into: what "
                 "went well, what didn't go well, and what to try differently. "
                 "For each item, note who raised it. End with the explicit "
                 "action items the team committed to and their owners. Skip "
                 "generic complaints that didn't lead to specific changes."),
                ("Project Kickoff", "Internal",
                 "Capture as a project kickoff. Sections: project goals and "
                 "success criteria, scope (in/out), key stakeholders and their "
                 "roles, timeline and major milestones, dependencies and risks "
                 "raised, and immediate next steps. Note any disagreements "
                 "about scope or approach that need follow-up."),

                # Hiring
                ("Candidate Interview", "Hiring",
                 "Format as an interview debrief. Capture: candidate's "
                 "background and experience relevant to the role, technical "
                 "depth demonstrated (with specific examples), areas of "
                 "strength, areas of concern, alignment with role requirements, "
                 "and a hire/no-hire/lean recommendation. Quote the candidate "
                 "where their words show fit or risk. Do not include illegal "
                 "or biased criteria."),
                ("Hiring Debrief", "Hiring",
                 "Format as a post-interview team debrief. Capture each "
                 "interviewer's recommendation (hire/no-hire/lean) and key "
                 "reasoning. Identify points of agreement and disagreement "
                 "across the panel. Note specific evidence cited for and "
                 "against. End with the consensus decision and any follow-up "
                 "steps (additional interview, reference check, offer "
                 "recommendation)."),

                # Customer Success
                ("Customer Check-in", "Customer Success",
                 "Recap as a customer success check-in. Capture: customer's "
                 "current state with the product, wins they've had, friction "
                 "or unresolved issues, requests for features or support, "
                 "expansion or contraction signals, and any executive "
                 "sponsorship changes. Note any commitments made by the CS "
                 "team and timing for follow-up."),
            ]
            cursor.executemany(
                "INSERT INTO saved_prompts (name, category, prompt_text, is_starter) "
                "VALUES (?, ?, ?, 1)",
                starters,
            )
            logger.info(f"[migration] Inserted {len(starters)} starter prompts")

        # Phase 3 Task 9: per-folder default saved prompt. ON DELETE
        # SET NULL means deleting a saved prompt that's referenced as a
        # folder default just clears the FK — no orphaned references,
        # no FK errors at runtime.
        cursor.execute("PRAGMA table_info(folders)")
        folder_cols = [row[1] for row in cursor.fetchall()]
        if folder_cols and "default_prompt_id" not in folder_cols:
            cursor.execute(
                "ALTER TABLE folders ADD COLUMN default_prompt_id INTEGER "
                "REFERENCES saved_prompts(id) ON DELETE SET NULL"
            )
            logger.info("[migration] Added folders.default_prompt_id")

        # Phase 3 Task 9: tag the source of a meeting's saved custom
        # summary prompt so the gear modal can show "From folder: X > Y"
        # when the prompt was auto-applied by the folder default. NULL =
        # nothing saved; 'manual' = user typed it; 'folder_default' =
        # auto-applied at /process-transcript time.
        if "summary_prompt_source" not in meeting_cols:
            cursor.execute(
                "ALTER TABLE meetings ADD COLUMN summary_prompt_source TEXT"
            )
            logger.info("[migration] Added meetings.summary_prompt_source")

        if "speaker_map" not in meeting_cols:
            cursor.execute(
                "ALTER TABLE meetings ADD COLUMN speaker_map TEXT DEFAULT NULL"
            )
            logger.info("[migration] Added meetings.speaker_map")

        # Phase 5 Task 2: in-pane welcome panel flag. Distinct from
        # has_seen_onboarding (which gates the auto-record consent
        # modal from Phase 2a). Decoupling them avoids two effects:
        #   - existing users who already passed the consent modal
        #     getting a surprise welcome panel after upgrading
        #   - the welcome panel being dismissed simultaneously with
        #     the consent modal (since both gate on the same flag)
        # Migration: existing has_seen_onboarding=1 rows are
        # backfilled to has_seen_welcome_panel=1 so only truly fresh
        # installs see the new welcome panel.
        if "has_seen_welcome_panel" not in settings_cols:
            cursor.execute(
                "ALTER TABLE settings ADD COLUMN has_seen_welcome_panel INTEGER DEFAULT 0"
            )
            cursor.execute(
                "UPDATE settings SET has_seen_welcome_panel = 1 "
                "WHERE has_seen_onboarding = 1"
            )
            logger.info("[migration] Added settings.has_seen_welcome_panel + backfill")

        # Phase 4 Task 1B: idempotent provider migration. After Task 1A
        # the settings row should already be on gemini, but installs
        # that ran an older build first will still have provider='ollama'
        # (and crash the now-removed model picker). Force them forward
        # here. No-op once migrated.
        cursor.execute("SELECT COUNT(*) FROM settings WHERE provider = 'ollama'")
        ollama_rows = cursor.fetchone()[0]
        if ollama_rows:
            cursor.execute(
                "UPDATE settings SET provider = 'gemini', model = 'gemini-2.5-flash' "
                "WHERE provider = 'ollama'"
            )
            logger.info(
                f"[migration] Updated {ollama_rows} settings row(s) from ollama -> gemini"
            )

        # Seed a default settings row (id='1') if none exists. Without this,
        # GET /get-model-config returns None and the route does None["provider"]
        # which 500s. Idempotent — does NOT overwrite an existing row.
        cursor.execute("SELECT id FROM settings WHERE id = '1'")
        if cursor.fetchone() is None:
            cursor.execute(
                """
                INSERT INTO settings (
                    id, provider, model, whisperModel,
                    auto_record_enabled, has_seen_onboarding,
                    auto_record_sources, theme,
                    has_seen_welcome_panel
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ("1", "gemini", "gemini-2.5-flash", "small", 1, 0,
                 "teams,meet,zoom,webex", "system", 0),
            )
            logger.info("[migration] Inserted default settings row")

        # Phase 5 Task 2: sample meeting seed for first-launch users.
        # Wrapped in try/except so a seed failure (schema drift, FK
        # mismatch, etc.) doesn't crash backend startup — log and
        # continue.
        try:
            self._maybe_seed_sample_meeting(cursor)
        except Exception as e:  # pragma: no cover - defensive
            logger.warning(f"[onboarding] Sample meeting seed failed: {e}")

    def _maybe_seed_sample_meeting(self, cursor):
        """Phase 5 Task 2: insert a single sample meeting on first
        launch so new users see what Neato Rewind produces before
        recording their first meeting.

        Triggers when:
          - has_seen_welcome_panel is 0 on the settings row, AND
          - meetings table has zero rows

        Idempotent: safe to call on every startup; no-op once either
        condition stops being true (welcome panel dismissed OR any
        meeting recorded). Existing users get has_seen_welcome_panel=1
        backfilled in the migration above so this never fires for
        them.
        """
        cursor.execute(
            "SELECT has_seen_welcome_panel FROM settings WHERE id = '1'"
        )
        row = cursor.fetchone()
        if row is None:
            # Settings row not initialised yet (the seed insert above
            # hasn't fired). Try again next startup.
            return
        seen = bool(row[0]) if row[0] is not None else False
        if seen:
            return

        cursor.execute("SELECT COUNT(*) FROM meetings")
        if cursor.fetchone()[0] > 0:
            return

        sample_id = "meeting-sample-onboarding"
        sample_title = "Sample: Q4 Product Roadmap Review"
        now = datetime.utcnow().isoformat()

        sample_transcript = (
            "Speaker 1: Alright, let's kick off the Q4 roadmap review. I want "
            "to talk through the three big bets we're making and get alignment "
            "on priorities before we lock the plan with engineering.\n\n"
            "Speaker 2: Sounds good. Should we start with the customer "
            "feedback we collected last quarter?\n\n"
            "Speaker 1: Yes, perfect framing. The top three themes from the "
            "feedback were: faster onboarding, deeper integrations with Slack "
            "and Notion, and better mobile experience. The mobile feedback in "
            "particular was strong — about 40% of our daily active users are "
            "mobile-first and we've been treating mobile as a second-class "
            "citizen.\n\n"
            "Speaker 2: I think the integrations work has the highest revenue "
            "impact based on our enterprise pipeline. Three of our top five "
            "deals last quarter cited integration depth as a deciding "
            "factor.\n\n"
            "Speaker 1: Agreed. Let's prioritize: integrations first, then "
            "mobile, then onboarding. For integrations, the immediate next "
            "step is scoping the Slack and Notion APIs and figuring out where "
            "the auth complexity lives.\n\n"
            "Speaker 2: I can own that scoping work and have a doc back to "
            "you by end of next week. Probably need a half day with the "
            "engineering team to sanity-check feasibility on the OAuth "
            "flow.\n\n"
            "Speaker 1: Perfect. Let's also book a session with the design "
            "team about mobile patterns. I want to see at least three concept "
            "directions before we commit to an approach. The mobile work is "
            "going to be at least a quarter of engineering capacity, so we "
            "need to get the direction right.\n\n"
            "Speaker 2: Will do. I'll set up the design review for the week "
            "after next once we've got the integration scope settled.\n\n"
            "Speaker 1: Last thing — onboarding. We're not going to ship a "
            "redesign this quarter, but I want a working group looking at "
            "the metrics. Where do users drop off in the first session, "
            "what's the activation rate by signup source, and is there a "
            "quick win in the first 60 seconds. If we can find a 5-percent "
            "activation lift from a small change, that's worth doing now "
            "even if the bigger redesign waits.\n\n"
            "Speaker 2: I'll pull the funnel data this week and circle back "
            "with options."
        )

        # Match the structured-summary shape produced by
        # process_transcript_background in main.py: 6 sections plus
        # MeetingName, each section is {title, blocks: [{id, content,
        # type, color}]}. The frontend's AISummary expects every
        # block to have a string `id` field (Block interface in
        # types/index.ts) — line 33 calls block.id.includes(sectionKey)
        # which throws TypeError if id is missing. Real meetings use
        # short ids like "ss1", "kid2"; the seed mirrors that
        # convention with a section-key-prefixed counter so the
        # includes() guard in AISummary's ensureUniqueBlockIds passes
        # and the existing ids stick across re-renders.
        def _section(section_key: str, title: str, contents: list) -> dict:
            return {
                "title": title,
                "blocks": [
                    {
                        "id": f"sample-{section_key}-{i + 1}",
                        "type": "bullet",
                        "content": text,
                        "color": "default",
                    }
                    for i, text in enumerate(contents)
                ],
            }

        sample_summary = {
            "MeetingName": "Q4 Product Roadmap Review",
            "SectionSummary": _section(
                "SectionSummary",
                "Section Summary",
                [
                    "Q4 priorities ranked: integrations (highest revenue "
                    "impact) first, then mobile, then onboarding.",
                    "Three of the top five enterprise deals last quarter "
                    "cited integration depth as a deciding factor.",
                    "40% of daily active users are mobile-first; team has "
                    "been treating mobile as a second-class citizen.",
                ],
            ),
            "CriticalDeadlines": {"title": "Critical Deadlines", "blocks": []},
            "KeyItemsDecisions": _section(
                "KeyItemsDecisions",
                "Key Items & Decisions",
                [
                    "Prioritise Slack/Notion integrations first; mobile "
                    "second; onboarding third.",
                    "Mobile redesign and onboarding redesign both deferred "
                    "out of Q4.",
                    "Integration scope and OAuth feasibility must be "
                    "confirmed before commitment.",
                ],
            ),
            "ImmediateActionItems": _section(
                "ImmediateActionItems",
                "Immediate Action Items",
                [
                    "Speaker 2 to scope Slack and Notion integration APIs "
                    "+ OAuth flow; doc back by end of next week.",
                    "Speaker 2 to schedule mobile concept-directions "
                    "design review (3+ options) for the week after.",
                    "Speaker 2 to pull onboarding funnel data this week "
                    "and surface quick-win options.",
                    "Half-day engineering review needed on integration "
                    "feasibility.",
                ],
            ),
            "NextSteps": {"title": "Next Steps", "blocks": []},
            "OtherImportantPoints": _section(
                "OtherImportantPoints",
                "Other Important Points",
                [
                    "Even before the bigger onboarding redesign, target a "
                    "5% activation lift from a small first-60-seconds "
                    "change.",
                ],
            ),
            "ClosingRemarks": {"title": "Closing Remarks", "blocks": []},
        }

        # Insert meeting row.
        cursor.execute(
            """
            INSERT INTO meetings (
                id, title, created_at, updated_at,
                detection_source, detection_confidence
            ) VALUES (?, ?, ?, ?, 'manual', 'manual')
            """,
            (sample_id, sample_title, now, now),
        )

        # Per-segment transcript row. transcripts.id is TEXT PK; we
        # generate a stable id off the meeting id so re-runs of the
        # seed (shouldn't happen, but defensive) don't UNIQUE-violate.
        cursor.execute(
            """
            INSERT INTO transcripts (id, meeting_id, transcript, timestamp)
            VALUES (?, ?, ?, '00:00')
            """,
            (f"{sample_id}-segment-0", sample_id, sample_transcript),
        )

        # transcript_chunks: one row per meeting (PK is meeting_id).
        cursor.execute(
            """
            INSERT INTO transcript_chunks (
                meeting_id, meeting_name, transcript_text,
                model, model_name, chunk_size, overlap, created_at
            ) VALUES (?, ?, ?, 'gemini', 'gemini-2.5-flash', 40000, 1000, ?)
            """,
            (sample_id, sample_title, sample_transcript, now),
        )

        # summary_processes: COMPLETED row carrying the JSON result.
        # Status uses the same casing convention create_process uses
        # (PENDING -> COMPLETED) so the existing get_summary endpoint
        # treats the row as done.
        cursor.execute(
            """
            INSERT INTO summary_processes (
                meeting_id, status, created_at, updated_at,
                start_time, end_time, result, error,
                chunk_count, processing_time
            ) VALUES (?, 'COMPLETED', ?, ?, ?, ?, ?, NULL, 1, 0.0)
            """,
            (sample_id, now, now, now, now, json.dumps(sample_summary)),
        )

        # 'sample' tag (case-insensitive UNIQUE on lower(name)). Use a
        # deterministic uuid hex so it's reproducible across re-seeds
        # in tests, but generate fresh in production.
        import uuid
        tag_id = uuid.uuid4().hex
        cursor.execute("SELECT id FROM tags WHERE LOWER(name) = LOWER(?)", ("sample",))
        existing = cursor.fetchone()
        if existing:
            tag_id = existing[0]
        else:
            cursor.execute(
                "INSERT INTO tags (id, name) VALUES (?, ?)",
                (tag_id, "sample"),
            )
        cursor.execute(
            "INSERT OR IGNORE INTO meeting_tags (meeting_id, tag_id) VALUES (?, ?)",
            (sample_id, tag_id),
        )

        logger.info(f"[onboarding] Seeded sample meeting {sample_id}")

    @asynccontextmanager
    async def _get_connection(self):
        """Get a new database connection.

        Phase 3 Task 7: enables foreign-key enforcement per-connection.
        SQLite turns FKs OFF by default; without this, ON DELETE
        SET NULL / CASCADE clauses (folders.parent_id, meetings.folder_id,
        meeting_tags.{meeting_id, tag_id}) would never fire.
        """
        conn = await aiosqlite.connect(self.db_path)
        try:
            await conn.execute("PRAGMA foreign_keys = ON")
            yield conn
        finally:
            await conn.close()

    async def create_process(self, meeting_id: str) -> str:
        """Create a new process entry or update existing one and return its ID"""
        now = datetime.utcnow().isoformat()
        
        async with self._get_connection() as conn:
            # First try to update existing process
            await conn.execute(
                """
                UPDATE summary_processes 
                SET status = ?, updated_at = ?, start_time = ?, error = NULL, result = NULL
                WHERE meeting_id = ?
                """,
                ("PENDING", now, now, meeting_id)
            )
            
            # If no rows were updated, insert a new one
            if conn.total_changes == 0:
                await conn.execute(
                    "INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, start_time) VALUES (?, ?, ?, ?, ?)",
                    (meeting_id, "PENDING", now, now, now)
                )
            
            await conn.commit()
        
        return meeting_id

    async def update_process(self, meeting_id: str, status: str, result: Optional[Dict] = None, error: Optional[str] = None, 
                           chunk_count: Optional[int] = None, processing_time: Optional[float] = None, 
                           metadata: Optional[Dict] = None):
        """Update a process status and result"""
        now = datetime.utcnow().isoformat()
        
        async with self._get_connection() as conn:
            update_fields = ["status = ?", "updated_at = ?"]
            params = [status, now]
            
            if result:
                update_fields.append("result = ?")
                params.append(json.dumps(result))
            if error:
                update_fields.append("error = ?")
                params.append(error)
            if chunk_count is not None:
                update_fields.append("chunk_count = ?")
                params.append(chunk_count)
            if processing_time is not None:
                update_fields.append("processing_time = ?")
                params.append(processing_time)
            if metadata:
                update_fields.append("metadata = ?")
                params.append(json.dumps(metadata))
            if status == 'COMPLETED' or status == 'FAILED':
                update_fields.append("end_time = ?")
                params.append(now)
                
            params.append(meeting_id)
            query = f"UPDATE summary_processes SET {', '.join(update_fields)} WHERE meeting_id = ?"
            await conn.execute(query, params)
            await conn.commit()

    async def save_transcript(self, meeting_id: str, transcript_text: str, model: str, model_name: str, 
                            chunk_size: int, overlap: int):
        """Save transcript data"""
        now = datetime.utcnow().isoformat()
        async with self._get_connection() as conn:
            # First try to update existing transcript
            await conn.execute("""
                UPDATE transcript_chunks 
                SET transcript_text = ?, model = ?, model_name = ?, chunk_size = ?, overlap = ?, created_at = ?
                WHERE meeting_id = ?
            """, (transcript_text, model, model_name, chunk_size, overlap, now, meeting_id))
            
            # If no rows were updated, insert a new one
            if conn.total_changes == 0:
                await conn.execute("""
                    INSERT INTO transcript_chunks (meeting_id, transcript_text, model, model_name, chunk_size, overlap, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (meeting_id, transcript_text, model, model_name, chunk_size, overlap, now))
            
            await conn.commit()

    async def update_meeting_name(self, meeting_id: str, meeting_name: str):
        """Update meeting name in both meetings and transcript_chunks tables"""
        now = datetime.utcnow().isoformat()
        async with self._get_connection() as conn:
            # Update meetings table
            await conn.execute("""
                UPDATE meetings
                SET title = ?, updated_at = ?
                WHERE id = ?
            """, (meeting_name, now, meeting_id))
            
            # Update transcript_chunks table
            await conn.execute("""
                UPDATE transcript_chunks
                SET meeting_name = ?
                WHERE meeting_id = ?
            """, (meeting_name, meeting_id))
            
            await conn.commit()

    async def get_transcript_data(self, meeting_id: str):
        """Get transcript data for a meeting.

        Phase 4 Task 1A: also pulls p.error so /get-summary can surface
        the real failure message (e.g. "GEMINI_API_KEY not configured")
        instead of the "Unknown processing error" fallback.
        """
        async with self._get_connection() as conn:
            async with conn.execute("""
                SELECT t.*, p.status, p.result, p.error
                FROM transcript_chunks t
                JOIN summary_processes p ON t.meeting_id = p.meeting_id
                WHERE t.meeting_id = ?
            """, (meeting_id,)) as cursor:
                row = await cursor.fetchone()
                if row:
                    return dict(zip([col[0] for col in cursor.description], row))
                return None

    async def save_meeting(
        self,
        meeting_id: str,
        title: str,
        detection_source: str = "manual",
        detection_confidence: str = "manual",
    ):
        """Save a meeting (insert-only, raises on id collision).

        Phase 2b: detection_source records WHICH layer(s) triggered the
        recording (e.g. "Microsoft Teams Meeting", "manual recording");
        detection_confidence records the confidence bucket
        ("manual"/"low"/"medium"/"high") at the moment of promotion.

        Phase 2b round 5: title is no longer a uniqueness constraint.
        Real recordings legitimately share titles (two "Auto: Google
        Meet" sessions on the same day are the common case). Only the
        primary key is checked.
        """
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT id FROM meetings WHERE id = ?", (meeting_id,))
                if cursor.fetchone() is not None:
                    raise Exception(f"Meeting with ID {meeting_id} already exists")
                cursor.execute(
                    """
                    INSERT INTO meetings (id, title, created_at, updated_at, detection_source, detection_confidence)
                    VALUES (?, ?, datetime('now'), datetime('now'), ?, ?)
                    """,
                    (meeting_id, title, detection_source, detection_confidence),
                )
                conn.commit()
                return True
        except Exception as e:
            logger.error(f"Error saving meeting: {str(e)}")
            raise

    async def upsert_meeting(
        self,
        meeting_id: str,
        title: str,
        detection_source: str = "manual",
        detection_confidence: str = "manual",
    ):
        """Insert or update a meeting row idempotently on `meeting_id`.

        Phase 2b round 5: the /save-transcript handler uses this so
        retries with the same caller-supplied meeting_id converge
        instead of 500-ing on duplicate. Title is intentionally NOT a
        uniqueness constraint here.
        """
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT id FROM meetings WHERE id = ?", (meeting_id,))
                if cursor.fetchone() is None:
                    cursor.execute(
                        """
                        INSERT INTO meetings
                            (id, title, created_at, updated_at,
                             detection_source, detection_confidence)
                        VALUES (?, ?, datetime('now'), datetime('now'), ?, ?)
                        """,
                        (meeting_id, title, detection_source, detection_confidence),
                    )
                else:
                    cursor.execute(
                        """
                        UPDATE meetings
                           SET title = ?,
                               updated_at = datetime('now'),
                               detection_source = ?,
                               detection_confidence = ?
                         WHERE id = ?
                        """,
                        (title, detection_source, detection_confidence, meeting_id),
                    )
                conn.commit()
                return True
        except Exception as e:
            logger.error(f"Error upserting meeting: {str(e)}")
            raise

    async def delete_meeting_transcripts(self, meeting_id: str):
        """Remove all transcripts for a given meeting_id.

        Used by /save-transcript before re-inserting the request's
        transcripts so that retries with the same id replace rather
        than duplicate.
        """
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute("DELETE FROM transcripts WHERE meeting_id = ?", (meeting_id,))
                conn.commit()
                return True
        except Exception as e:
            logger.error(f"Error deleting transcripts for {meeting_id}: {str(e)}")
            raise

    async def save_meeting_transcript(self, meeting_id: str, transcript: str, timestamp: str, summary: str = "", action_items: str = "", key_points: str = ""):
        """Save a transcript for a meeting"""
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                
                # Save transcript
                cursor.execute("""
                    INSERT INTO transcripts (
                        meeting_id, transcript, timestamp, summary, action_items, key_points
                    ) VALUES (?, ?, ?, ?, ?, ?)
                """, (meeting_id, transcript, timestamp, summary, action_items, key_points))
                
                conn.commit()
                return True
        except Exception as e:
            logger.error(f"Error saving transcript: {str(e)}")
            raise

    async def get_meeting(self, meeting_id: str):
        """Get a meeting by ID with its transcripts, folder, and tags."""
        try:
            async with self._get_connection() as conn:
                # Phase 3 Task 7: select folder_id alongside the
                # existing meeting fields. Tags fetched in a second
                # query to avoid CROSS JOIN row-multiplication.
                cursor = await conn.execute("""
                    SELECT id, title, created_at, updated_at, folder_id, speaker_map
                    FROM meetings
                    WHERE id = ?
                """, (meeting_id,))
                meeting = await cursor.fetchone()

                if not meeting:
                    return None

                # Get all transcripts for this meeting
                cursor = await conn.execute("""
                    SELECT transcript, timestamp
                    FROM transcripts
                    WHERE meeting_id = ?
                """, (meeting_id,))
                transcripts = await cursor.fetchall()

                # Get tags
                cursor = await conn.execute("""
                    SELECT t.id, t.name
                    FROM meeting_tags mt
                    JOIN tags t ON t.id = mt.tag_id
                    WHERE mt.meeting_id = ?
                    ORDER BY LOWER(t.name)
                """, (meeting_id,))
                tag_rows = await cursor.fetchall()

                import json as _json
                raw_map = meeting[5]
                speaker_map = _json.loads(raw_map) if raw_map else {}

                return {
                    'id': meeting[0],
                    'title': meeting[1],
                    'created_at': meeting[2],
                    'updated_at': meeting[3],
                    'folder_id': meeting[4],
                    'speaker_map': speaker_map,
                    'tags': [{'id': r[0], 'name': r[1]} for r in tag_rows],
                    'transcripts': [{
                        'id': meeting_id,
                        'text': transcript[0],
                        'timestamp': transcript[1]
                    } for transcript in transcripts]
                }
        except Exception as e:
            logger.error(f"Error getting meeting: {str(e)}")
            raise

    async def save_speaker_map(self, meeting_id: str, speaker_map: dict) -> None:
        """Persist the AI-identified (or manually edited) speaker name map."""
        import json as _json
        async with self._get_connection() as conn:
            await conn.execute(
                "UPDATE meetings SET speaker_map = ? WHERE id = ?",
                (_json.dumps(speaker_map), meeting_id),
            )
            await conn.commit()

    # ------------------------------------------------------------------
    # Ask history
    # ------------------------------------------------------------------

    @staticmethod
    def _row_to_ask_history(row) -> dict:
        import json as _json
        try:
            citations = _json.loads(row[4]) if row[4] else []
        except (ValueError, TypeError):
            citations = []
        return {
            "id": row[0],
            "created_at": row[1],
            "question": row[2],
            "answer": row[3],
            "citations": citations,
            "meeting_id": row[5],
            "scope_label": row[6],
            "pinned": bool(row[7]),
        }

    _ASK_HISTORY_COLS = (
        "id, created_at, question, answer, citations, "
        "meeting_id, scope_label, pinned"
    )

    async def save_ask_history(
        self,
        question: str,
        answer: str,
        citations: list,
        meeting_id: Optional[str] = None,
        scope_label: Optional[str] = None,
    ) -> int:
        """Record one /ask exchange. Returns the new row id."""
        import json as _json
        created_at = datetime.now(timezone.utc).isoformat()
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                INSERT INTO ask_history
                    (created_at, question, answer, citations, meeting_id, scope_label)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    created_at,
                    question,
                    answer,
                    _json.dumps(citations or []),
                    meeting_id,
                    scope_label,
                ),
            )
            await conn.commit()
            return cursor.lastrowid

    async def get_ask_history(
        self,
        limit: int = 100,
        meeting_id: Optional[str] = None,
        global_only: bool = False,
    ) -> list:
        """List past exchanges, pinned first then newest first.

        `meeting_id` restricts to one recording's history; `global_only`
        restricts to corpus-wide questions (those with no meeting_id).
        Passing neither returns everything.
        """
        where = ""
        params: list = []
        if meeting_id is not None:
            where = "WHERE meeting_id = ?"
            params.append(meeting_id)
        elif global_only:
            where = "WHERE meeting_id IS NULL"
        params.append(limit)

        async with self._get_connection() as conn:
            cursor = await conn.execute(
                f"""
                SELECT {self._ASK_HISTORY_COLS}
                FROM ask_history
                {where}
                ORDER BY pinned DESC, created_at DESC
                LIMIT ?
                """,
                tuple(params),
            )
            rows = await cursor.fetchall()
            return [self._row_to_ask_history(r) for r in rows]

    async def set_ask_history_pinned(self, history_id: int, pinned: bool) -> bool:
        """Pin/unpin an exchange. False when the row doesn't exist."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "UPDATE ask_history SET pinned = ? WHERE id = ?",
                (1 if pinned else 0, history_id),
            )
            await conn.commit()
            return cursor.rowcount > 0

    async def delete_ask_history(self, history_id: int) -> bool:
        """Delete one exchange. False when the row doesn't exist."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "DELETE FROM ask_history WHERE id = ?", (history_id,)
            )
            await conn.commit()
            return cursor.rowcount > 0

    async def get_meeting_title(self, meeting_id: str) -> Optional[str]:
        """Phase 3 Task 8: read just the current title for a meeting.

        Used by the post-summary auto-rename guard to decide whether
        the LLM-suggested title should overwrite the existing one.
        Returns None when no row matches.
        """
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT title FROM meetings WHERE id = ?",
                (meeting_id,),
            )
            row = await cursor.fetchone()
            return row[0] if row else None

    async def update_meeting_title(self, meeting_id: str, new_title: str) -> bool:
        """Update a meeting's title.

        Returns True if a row was updated, False if no row matched the
        given id (caller should surface a 404). Phase 3 Task 6: enables
        the endpoint layer to distinguish "successfully renamed" from
        "no such meeting".
        """
        now = datetime.utcnow().isoformat()
        async with self._get_connection() as conn:
            cursor = await conn.execute("""
                UPDATE meetings
                SET title = ?, updated_at = ?
                WHERE id = ?
            """, (new_title, now, meeting_id))
            await conn.commit()
            return (cursor.rowcount or 0) > 0

    async def get_all_meetings(self):
        """Get all meetings with basic info, folder, and tags.

        Phase 3 Task 7: includes folder_id and a tags array of
        {id, name} objects so the sidebar and meeting-details views
        can render organization affordances without a follow-up
        round-trip per meeting.
        """
        async with self._get_connection() as conn:
            cursor = await conn.execute("""
                SELECT id, title, created_at, folder_id
                FROM meetings
                ORDER BY created_at DESC
            """)
            rows = await cursor.fetchall()
            meetings = [{
                'id': row[0],
                'title': row[1],
                'created_at': row[2],
                'folder_id': row[3],
                'tags': [],
            } for row in rows]
            if not meetings:
                return meetings
            # Bulk-fetch tags for all meetings, then group in Python.
            # Avoids N+1 even if the meeting list grows.
            cursor = await conn.execute("""
                SELECT mt.meeting_id, t.id, t.name
                FROM meeting_tags mt
                JOIN tags t ON t.id = mt.tag_id
            """)
            tag_rows = await cursor.fetchall()
            by_meeting = {}
            for meeting_id, tag_id, tag_name in tag_rows:
                by_meeting.setdefault(meeting_id, []).append(
                    {'id': tag_id, 'name': tag_name}
                )
            for m in meetings:
                m['tags'] = by_meeting.get(m['id'], [])
            return meetings

    # ---------- Phase 3 Task 7: folders ----------

    async def list_folders(self):
        """Return all folders ordered by name.

        Phase 3 Task 9: LEFT JOIN saved_prompts so each folder row
        includes its default prompt id + denormalised name/category for
        rendering in the sidebar / Settings without a second round-trip.
        """
        async with self._get_connection() as conn:
            cursor = await conn.execute("""
                SELECT f.id, f.name, f.parent_id, f.created_at,
                       f.default_prompt_id,
                       sp.name AS default_prompt_name,
                       sp.category AS default_prompt_category
                FROM folders f
                LEFT JOIN saved_prompts sp ON sp.id = f.default_prompt_id
                ORDER BY LOWER(f.name)
            """)
            rows = await cursor.fetchall()
            return [{
                'id': row[0],
                'name': row[1],
                'parent_id': row[2],
                'created_at': row[3],
                'default_prompt_id': row[4],
                'default_prompt_name': row[5],
                'default_prompt_category': row[6],
            } for row in rows]

    async def set_folder_default_prompt(
        self, folder_id: str, prompt_id
    ) -> bool:
        """Phase 3 Task 9: assign or clear a folder's default summary
        prompt. Pass prompt_id=None to clear. Returns True iff the
        folder row was updated."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "UPDATE folders SET default_prompt_id = ? WHERE id = ?",
                (prompt_id, folder_id),
            )
            await conn.commit()
            return (cursor.rowcount or 0) > 0

    async def get_folder_default_prompt(self, folder_id: str):
        """Return {default_prompt_id, prompt_text, prompt_name,
        prompt_category} for the folder, or None if the folder either
        doesn't exist or has no default set / its referenced prompt
        was deleted."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                SELECT f.default_prompt_id, sp.prompt_text, sp.name, sp.category
                FROM folders f
                LEFT JOIN saved_prompts sp ON sp.id = f.default_prompt_id
                WHERE f.id = ?
                """,
                (folder_id,),
            )
            row = await cursor.fetchone()
            if row is None or row[0] is None or row[1] is None:
                return None
            return {
                "default_prompt_id": row[0],
                "prompt_text": row[1],
                "prompt_name": row[2],
                "prompt_category": row[3],
            }

    async def create_folder(self, folder_id: str, name: str, parent_id):
        """Create a folder. Caller supplies a uuid hex id."""
        async with self._get_connection() as conn:
            await conn.execute(
                """
                INSERT INTO folders (id, name, parent_id, created_at)
                VALUES (?, ?, ?, datetime('now'))
                """,
                (folder_id, name, parent_id),
            )
            await conn.commit()

    async def rename_folder(self, folder_id: str, new_name: str) -> bool:
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "UPDATE folders SET name = ? WHERE id = ?",
                (new_name, folder_id),
            )
            await conn.commit()
            return (cursor.rowcount or 0) > 0

    async def delete_folder(self, folder_id: str) -> bool:
        """Delete a folder. Meetings in the folder are uncategorized
        (folder_id set to NULL) via ON DELETE SET NULL on the FK.
        Child folders also become top-level via the same mechanism.
        """
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "DELETE FROM folders WHERE id = ?",
                (folder_id,),
            )
            await conn.commit()
            return (cursor.rowcount or 0) > 0

    async def set_meeting_folder(self, meeting_id: str, folder_id) -> bool:
        """Assign a meeting to a folder, or pass folder_id=None to
        uncategorize. Returns True if the meeting row was updated.
        """
        now = datetime.utcnow().isoformat()
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "UPDATE meetings SET folder_id = ?, updated_at = ? WHERE id = ?",
                (folder_id, now, meeting_id),
            )
            await conn.commit()
            return (cursor.rowcount or 0) > 0

    # ---------- Phase 3 Task 7: tags ----------

    async def list_tags(self):
        """All tags + usage count (number of meetings each is on)."""
        async with self._get_connection() as conn:
            cursor = await conn.execute("""
                SELECT t.id, t.name, t.created_at,
                       COUNT(mt.meeting_id) AS usage_count
                FROM tags t
                LEFT JOIN meeting_tags mt ON mt.tag_id = t.id
                GROUP BY t.id, t.name, t.created_at
                ORDER BY LOWER(t.name)
            """)
            rows = await cursor.fetchall()
            return [{
                'id': row[0],
                'name': row[1],
                'created_at': row[2],
                'usage_count': row[3],
            } for row in rows]

    async def find_tag_by_name(self, name: str):
        """Case-insensitive lookup by tag name. Returns the row or None."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT id, name, created_at FROM tags WHERE LOWER(name) = LOWER(?)",
                (name,),
            )
            row = await cursor.fetchone()
            if not row:
                return None
            return {'id': row[0], 'name': row[1], 'created_at': row[2]}

    async def create_tag(self, tag_id: str, name: str):
        async with self._get_connection() as conn:
            await conn.execute(
                """
                INSERT INTO tags (id, name, created_at)
                VALUES (?, ?, datetime('now'))
                """,
                (tag_id, name),
            )
            await conn.commit()

    async def delete_tag(self, tag_id: str) -> bool:
        """Delete a tag globally. ON DELETE CASCADE removes it from
        every meeting it was attached to.
        """
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "DELETE FROM tags WHERE id = ?",
                (tag_id,),
            )
            await conn.commit()
            return (cursor.rowcount or 0) > 0

    async def add_meeting_tag(self, meeting_id: str, tag_id: str) -> bool:
        """Attach a tag to a meeting. Idempotent — returns True even
        if the (meeting, tag) pair already exists. Returns False only
        on FK / integrity errors (caller's been given bad ids).
        """
        async with self._get_connection() as conn:
            try:
                await conn.execute(
                    """
                    INSERT OR IGNORE INTO meeting_tags (meeting_id, tag_id)
                    VALUES (?, ?)
                    """,
                    (meeting_id, tag_id),
                )
                await conn.commit()
                return True
            except Exception as e:
                logger.error(f"add_meeting_tag({meeting_id}, {tag_id}) failed: {e}")
                return False

    async def remove_meeting_tag(self, meeting_id: str, tag_id: str) -> bool:
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "DELETE FROM meeting_tags WHERE meeting_id = ? AND tag_id = ?",
                (meeting_id, tag_id),
            )
            await conn.commit()
            return (cursor.rowcount or 0) > 0

    async def get_meeting_tags(self, meeting_id: str):
        """Tags attached to a single meeting."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                """
                SELECT t.id, t.name
                FROM meeting_tags mt
                JOIN tags t ON t.id = mt.tag_id
                WHERE mt.meeting_id = ?
                ORDER BY LOWER(t.name)
                """,
                (meeting_id,),
            )
            rows = await cursor.fetchall()
            return [{'id': row[0], 'name': row[1]} for row in rows]

    async def delete_meeting(self, meeting_id: str):
        """Delete a meeting and all its associated data"""
        async with self._get_connection() as conn:
            try:
                # Delete from transcript_chunks
                await conn.execute("DELETE FROM transcript_chunks WHERE meeting_id = ?", (meeting_id,))
                
                # Delete from summary_processes
                await conn.execute("DELETE FROM summary_processes WHERE meeting_id = ?", (meeting_id,))
                
                # Delete from transcripts
                await conn.execute("DELETE FROM transcripts WHERE meeting_id = ?", (meeting_id,))
                
                # Delete from meetings
                await conn.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))
                
                await conn.commit()
                return True
            except Exception as e:
                logger.error(f"Error deleting meeting {meeting_id}: {str(e)}")
                return False

    async def get_model_config(self):
        """Get the current model configuration"""
        async with self._get_connection() as conn:
            cursor = await conn.execute("SELECT provider, model, whisperModel FROM settings")
            row = await cursor.fetchone()
            return dict(zip([col[0] for col in cursor.description], row)) if row else None

    async def save_model_config(self, provider: str, model: str, whisperModel: str):
        """Save the model configuration"""
        async with self._get_connection() as conn:
            # Check if the configuration already exists
            cursor = await conn.execute("SELECT id FROM settings")
            existing_config = await cursor.fetchone()
            if existing_config:
                # Update existing configuration
                await conn.execute("""
                    UPDATE settings 
                    SET provider = ?, model = ?, whisperModel = ?
                    WHERE id = '1'    
                """, (provider, model, whisperModel))
            else:
                # Insert new configuration
                await conn.execute("""
                    INSERT INTO settings (id, provider, model, whisperModel)
                    VALUES (?, ?, ?, ?)
                """, ('1', provider, model, whisperModel))
            await conn.commit()


    # Phase 4 Task 1A: centralised provider→column mapping. Adding a
    # provider here is a one-line change; the three CRUD methods below
    # all consult this map and raise ValueError for unknown providers.
    _PROVIDER_API_KEY_COLUMN = {
        "openai": "openaiApiKey",
        "claude": "anthropicApiKey",
        "groq": "groqApiKey",
        "ollama": "ollamaApiKey",
        "gemini": "geminiApiKey",
    }

    async def save_api_key(self, api_key: str, provider: str):
        """Save the API key"""
        api_key_name = self._PROVIDER_API_KEY_COLUMN.get(provider)
        if api_key_name is None:
            raise ValueError(f"Invalid provider: {provider}")
        async with self._get_connection() as conn:
            await conn.execute(f"UPDATE settings SET {api_key_name} = ? WHERE id = '1'", (api_key,))
            await conn.commit()

    async def get_api_key(self, provider: str):
        """Get the API key"""
        api_key_name = self._PROVIDER_API_KEY_COLUMN.get(provider)
        if api_key_name is None:
            raise ValueError(f"Invalid provider: {provider}")
        async with self._get_connection() as conn:
            cursor = await conn.execute(f"SELECT {api_key_name} FROM settings WHERE id = '1'")
            row = await cursor.fetchone()
            return row[0] if row else None
        
    # Phase 4 Task 1B: app-level settings (Settings page).
    # ----------------------------------------------------
    # Source of truth is the same `settings` row at id='1'. We expose
    # a focused async API rather than letting callers SELECT * because
    # the settings table also holds API-key columns that should stay
    # behind get_api_key.

    # Phase 7 Task 5: "browser" is included by default so the existing
    # YouTube-records-when-Zoom-is-in-tray behavior is preserved on
    # fresh installs; users who don't want it can toggle "Browser
    # audio" off in Settings. The migration below appends "browser"
    # to any existing settings row that's missing it so behavior
    # stays the same across upgrades.
    _DEFAULT_AUTO_RECORD_SOURCES = ["teams", "meet", "zoom", "webex", "browser"]
    _ALLOWED_THEMES = ("light", "dark", "system")

    @staticmethod
    def _parse_sources(raw: Optional[str]) -> list:
        """CSV → list. Empty/None → defaults. Defensive trim + dedupe."""
        if not raw:
            return list(DatabaseManager._DEFAULT_AUTO_RECORD_SOURCES)
        seen, out = set(), []
        for piece in raw.split(","):
            key = piece.strip().lower()
            if key and key not in seen:
                seen.add(key)
                out.append(key)
        return out

    async def get_app_settings(self) -> dict:
        """Return the user-facing app settings as a typed dict.

        Falls back to documented defaults when columns are NULL or no
        row exists yet. Only fields that the Settings page surfaces are
        returned; provider/model/api keys live behind separate APIs.
        """
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT auto_record_enabled, auto_record_sources, "
                "default_folder_id, theme FROM settings WHERE id = '1'"
            )
            row = await cursor.fetchone()
        if row is None:
            return {
                "auto_record_enabled": True,
                "auto_record_sources": list(self._DEFAULT_AUTO_RECORD_SOURCES),
                "default_folder_id": None,
                "theme": "system",
            }
        auto_enabled, sources_csv, folder_id, theme = row
        return {
            "auto_record_enabled": bool(auto_enabled) if auto_enabled is not None else True,
            "auto_record_sources": self._parse_sources(sources_csv),
            "default_folder_id": folder_id,
            "theme": theme if theme in self._ALLOWED_THEMES else "system",
        }

    async def update_app_settings(
        self,
        auto_record_enabled: Optional[bool] = None,
        auto_record_sources: Optional[list] = None,
        default_folder_id: Optional[str] = None,
        clear_default_folder: bool = False,
        theme: Optional[str] = None,
    ) -> dict:
        """Partial update — None means "leave as-is".

        `clear_default_folder=True` disambiguates the "set folder to
        Uncategorized" case (NULL) from "don't touch this field"
        (None). The PATCH endpoint translates an explicit JSON
        ``"default_folder_id": null`` to clear=True.
        """
        sets, params = [], []
        if auto_record_enabled is not None:
            sets.append("auto_record_enabled = ?")
            params.append(1 if auto_record_enabled else 0)
        if auto_record_sources is not None:
            cleaned = ",".join(self._parse_sources(",".join(auto_record_sources)))
            sets.append("auto_record_sources = ?")
            params.append(cleaned)
        if default_folder_id is not None:
            sets.append("default_folder_id = ?")
            params.append(default_folder_id)
        elif clear_default_folder:
            sets.append("default_folder_id = NULL")
        if theme is not None:
            if theme not in self._ALLOWED_THEMES:
                raise ValueError(f"Invalid theme: {theme}")
            sets.append("theme = ?")
            params.append(theme)

        if sets:
            async with self._get_connection() as conn:
                await conn.execute("SELECT id FROM settings WHERE id = '1'")
                params.append("1")
                await conn.execute(
                    f"UPDATE settings SET {', '.join(sets)} WHERE id = ?",
                    params,
                )
                await conn.commit()
        return await self.get_app_settings()

    async def get_meeting_custom_prompt(self, meeting_id: str) -> Optional[str]:
        """Phase 4 Task 1B: read the per-meeting custom summary prompt
        (or None when unset). Used by /process-transcript to extend the
        standard prompt with the user's instructions."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT custom_summary_prompt FROM meetings WHERE id = ?",
                (meeting_id,),
            )
            row = await cursor.fetchone()
            return row[0] if row else None

    async def update_meeting_custom_prompt(
        self, meeting_id: str, prompt: Optional[str],
        source: Optional[str] = "manual",
    ) -> bool:
        """Set or clear the per-meeting custom prompt. ``None`` clears
        the column. Returns whether a row was actually updated (False
        when the meeting id doesn't exist).

        Phase 3 Task 9: also writes summary_prompt_source. Defaults to
        'manual' (covers the gear-modal save path); pass
        source='folder_default' when the folder default fires
        automatically. When prompt is None the source column is
        cleared too."""
        now = datetime.utcnow().isoformat()
        effective_source = source if prompt is not None else None
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "UPDATE meetings SET custom_summary_prompt = ?, "
                "summary_prompt_source = ?, updated_at = ? WHERE id = ?",
                (prompt, effective_source, now, meeting_id),
            )
            await conn.commit()
            return (cursor.rowcount or 0) > 0

    async def get_meeting_summary_prompt_source(
        self, meeting_id: str
    ) -> Optional[str]:
        """Phase 3 Task 9: read where the saved custom prompt came
        from. Returns 'manual', 'folder_default', or None."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT summary_prompt_source FROM meetings WHERE id = ?",
                (meeting_id,),
            )
            row = await cursor.fetchone()
            return row[0] if row else None

    async def get_meeting_folder_id(
        self, meeting_id: str
    ) -> Optional[str]:
        """Phase 3 Task 9: lightweight folder-id lookup for the
        process_transcript_background fallback path."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT folder_id FROM meetings WHERE id = ?",
                (meeting_id,),
            )
            row = await cursor.fetchone()
            return row[0] if row else None

    # Phase 4 Task 1D: saved-prompt library.
    # ---------------------------------------
    # Single-user desktop app, so no multi-tenant concerns. The Settings
    # page never exposes these — entry point is the meeting-detail
    # CustomSummaryPromptModal.

    async def list_saved_prompts(self) -> list:
        """Return all saved prompts ordered by category then name."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT id, name, category, prompt_text, is_starter, "
                "created_at, use_count FROM saved_prompts "
                "ORDER BY category COLLATE NOCASE, name COLLATE NOCASE"
            )
            rows = await cursor.fetchall()
            return [
                {
                    "id": r[0],
                    "name": r[1],
                    "category": r[2],
                    "prompt_text": r[3],
                    "is_starter": bool(r[4]),
                    "created_at": str(r[5]) if r[5] is not None else "",
                    "use_count": int(r[6] or 0),
                }
                for r in rows
            ]

    async def create_saved_prompt(
        self, name: str, category: str, prompt_text: str
    ) -> dict:
        """Insert a new saved prompt and return the row (with assigned id).

        is_starter is always 0 for user-created entries — only the
        migration's seed marks rows as starters.
        """
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "INSERT INTO saved_prompts (name, category, prompt_text, is_starter) "
                "VALUES (?, ?, ?, 0)",
                (name, category, prompt_text),
            )
            new_id = cursor.lastrowid
            await conn.commit()
            row_cursor = await conn.execute(
                "SELECT id, name, category, prompt_text, is_starter, "
                "created_at, use_count FROM saved_prompts WHERE id = ?",
                (new_id,),
            )
            row = await row_cursor.fetchone()
        return {
            "id": row[0],
            "name": row[1],
            "category": row[2],
            "prompt_text": row[3],
            "is_starter": bool(row[4]),
            "created_at": str(row[5]) if row[5] is not None else "",
            "use_count": int(row[6] or 0),
        }

    async def delete_saved_prompt(self, prompt_id: int) -> bool:
        """Delete a saved prompt. Returns True iff a row was removed.

        Starters are deletable on purpose — once gone, they stay gone
        (the seed only fires on an empty is_starter=1 set).
        """
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "DELETE FROM saved_prompts WHERE id = ?", (prompt_id,)
            )
            await conn.commit()
            return (cursor.rowcount or 0) > 0

    async def increment_saved_prompt_use_count(self, prompt_id: int) -> bool:
        """Bump use_count on a saved prompt. Best-effort — caller should
        ignore False (the prompt may have been deleted in another tab)."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "UPDATE saved_prompts SET use_count = use_count + 1 WHERE id = ?",
                (prompt_id,),
            )
            await conn.commit()
            return (cursor.rowcount or 0) > 0

    async def get_recording_settings(self):
        """Phase 2a: read auto_record_enabled and has_seen_onboarding.

        Phase 5 Task 2: also reads has_seen_welcome_panel.

        Defaults applied when no settings row exists yet:
            auto_record_enabled = True (Phase 2a default-ON for new installs)
            has_seen_onboarding = False
            has_seen_welcome_panel = False
        """
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT auto_record_enabled, has_seen_onboarding, "
                "has_seen_welcome_panel, auto_summarize_enabled "
                "FROM settings WHERE id = '1'"
            )
            row = await cursor.fetchone()
            if row is None:
                return {
                    "auto_record_enabled": True,
                    "has_seen_onboarding": False,
                    "has_seen_welcome_panel": False,
                    "auto_summarize_enabled": True,
                }
            return {
                "auto_record_enabled": bool(row[0]) if row[0] is not None else True,
                "has_seen_onboarding": bool(row[1]) if row[1] is not None else False,
                "has_seen_welcome_panel": bool(row[2]) if row[2] is not None else False,
                "auto_summarize_enabled": bool(row[3]) if row[3] is not None else True,
            }

    async def set_recording_settings(
        self, auto_record_enabled=None, has_seen_onboarding=None,
        has_seen_welcome_panel=None, auto_summarize_enabled=None,
    ):
        """Phase 2a: update recording-related settings. Creates the row if absent.

        Phase 5 Task 2: also accepts has_seen_welcome_panel (the
        in-pane welcome flag, distinct from has_seen_onboarding which
        gates the auto-record consent modal)."""
        async with self._get_connection() as conn:
            cursor = await conn.execute("SELECT id FROM settings WHERE id = '1'")
            existing = await cursor.fetchone()

            if existing is None:
                # Need a settings row to update. The settings table's NOT NULL columns
                # (provider/model/whisperModel) default to placeholder values that the
                # model-config endpoint will overwrite later.
                await conn.execute(
                    """
                    INSERT INTO settings (
                        id, provider, model, whisperModel,
                        auto_record_enabled, has_seen_onboarding,
                        has_seen_welcome_panel, auto_summarize_enabled
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "1",
                        "",
                        "",
                        "",
                        1 if (auto_record_enabled if auto_record_enabled is not None else True) else 0,
                        1 if (has_seen_onboarding if has_seen_onboarding is not None else False) else 0,
                        1 if (has_seen_welcome_panel if has_seen_welcome_panel is not None else False) else 0,
                        1 if (auto_summarize_enabled if auto_summarize_enabled is not None else True) else 0,
                    ),
                )
            else:
                update_fields = []
                params = []
                if auto_record_enabled is not None:
                    update_fields.append("auto_record_enabled = ?")
                    params.append(1 if auto_record_enabled else 0)
                if has_seen_onboarding is not None:
                    update_fields.append("has_seen_onboarding = ?")
                    params.append(1 if has_seen_onboarding else 0)
                if has_seen_welcome_panel is not None:
                    update_fields.append("has_seen_welcome_panel = ?")
                    params.append(1 if has_seen_welcome_panel else 0)
                if auto_summarize_enabled is not None:
                    update_fields.append("auto_summarize_enabled = ?")
                    params.append(1 if auto_summarize_enabled else 0)
                if update_fields:
                    query = f"UPDATE settings SET {', '.join(update_fields)} WHERE id = '1'"
                    await conn.execute(query, params)

            await conn.commit()

    async def delete_api_key(self, provider: str):
        """Delete the API key"""
        api_key_name = self._PROVIDER_API_KEY_COLUMN.get(provider)
        if api_key_name is None:
            raise ValueError(f"Invalid provider: {provider}")
        async with self._get_connection() as conn:
            await conn.execute(f"UPDATE settings SET {api_key_name} = NULL WHERE id = '1'")
            await conn.commit()
            
   

