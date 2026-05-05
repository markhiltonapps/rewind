import aiosqlite
import json
from datetime import datetime
from typing import Optional, Dict
import logging
from contextlib import asynccontextmanager
import sqlite3

logger = logging.getLogger(__name__)

class DatabaseManager:
    def __init__(self, db_path: str = "meeting_minutes.db"):
        self.db_path = db_path
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
                    has_seen_onboarding INTEGER DEFAULT 0
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
                "DEFAULT 'teams,meet,zoom,webex'"
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
            starters = [
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
            ]
            cursor.executemany(
                "INSERT INTO saved_prompts (name, category, prompt_text, is_starter) "
                "VALUES (?, ?, ?, 1)",
                starters,
            )
            logger.info(f"[migration] Inserted {len(starters)} starter prompts")

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
                    auto_record_sources, theme
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ("1", "gemini", "gemini-2.5-flash", "small", 1, 0,
                 "teams,meet,zoom,webex", "system"),
            )
            logger.info("[migration] Inserted default settings row")

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
                    SELECT id, title, created_at, updated_at, folder_id
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

                return {
                    'id': meeting[0],
                    'title': meeting[1],
                    'created_at': meeting[2],
                    'updated_at': meeting[3],
                    'folder_id': meeting[4],
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
        """Return all folders ordered by name."""
        async with self._get_connection() as conn:
            cursor = await conn.execute("""
                SELECT id, name, parent_id, created_at
                FROM folders
                ORDER BY LOWER(name)
            """)
            rows = await cursor.fetchall()
            return [{
                'id': row[0],
                'name': row[1],
                'parent_id': row[2],
                'created_at': row[3],
            } for row in rows]

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

    _DEFAULT_AUTO_RECORD_SOURCES = ["teams", "meet", "zoom", "webex"]
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
        self, meeting_id: str, prompt: Optional[str]
    ) -> bool:
        """Set or clear the per-meeting custom prompt. ``None`` clears
        the column. Returns whether a row was actually updated (False
        when the meeting id doesn't exist)."""
        now = datetime.utcnow().isoformat()
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "UPDATE meetings SET custom_summary_prompt = ?, updated_at = ? "
                "WHERE id = ?",
                (prompt, now, meeting_id),
            )
            await conn.commit()
            return (cursor.rowcount or 0) > 0

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

        Defaults applied when no settings row exists yet:
            auto_record_enabled = True (Phase 2a default-ON for new installs)
            has_seen_onboarding = False
        """
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT auto_record_enabled, has_seen_onboarding FROM settings WHERE id = '1'"
            )
            row = await cursor.fetchone()
            if row is None:
                return {"auto_record_enabled": True, "has_seen_onboarding": False}
            return {
                "auto_record_enabled": bool(row[0]) if row[0] is not None else True,
                "has_seen_onboarding": bool(row[1]) if row[1] is not None else False,
            }

    async def set_recording_settings(self, auto_record_enabled=None, has_seen_onboarding=None):
        """Phase 2a: update recording-related settings. Creates the row if absent."""
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
                        auto_record_enabled, has_seen_onboarding
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "1",
                        "",
                        "",
                        "",
                        1 if (auto_record_enabled if auto_record_enabled is not None else True) else 0,
                        1 if (has_seen_onboarding if has_seen_onboarding is not None else False) else 0,
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
            
   

