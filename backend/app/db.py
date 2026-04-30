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
                    auto_record_enabled INTEGER DEFAULT 1,
                    has_seen_onboarding INTEGER DEFAULT 0
                )
            """)

            # Idempotent migrations for existing installs (Phase 2a)
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

        # Seed a default settings row (id='1') if none exists. Without this,
        # GET /get-model-config returns None and the route does None["provider"]
        # which 500s. Idempotent — does NOT overwrite an existing row.
        cursor.execute("SELECT id FROM settings WHERE id = '1'")
        if cursor.fetchone() is None:
            cursor.execute(
                """
                INSERT INTO settings (
                    id, provider, model, whisperModel,
                    auto_record_enabled, has_seen_onboarding
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                ("1", "ollama", "llama3.2:latest", "small", 1, 0),
            )

    @asynccontextmanager
    async def _get_connection(self):
        """Get a new database connection"""
        conn = await aiosqlite.connect(self.db_path)
        try:
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
        """Get transcript data for a meeting"""
        async with self._get_connection() as conn:
            async with conn.execute("""
                SELECT t.*, p.status, p.result 
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
        """Save or update a meeting.

        Phase 2b: detection_source records WHICH layer(s) triggered the
        recording (e.g. "Microsoft Teams Meeting", "manual recording");
        detection_confidence records the confidence bucket
        ("manual"/"low"/"medium"/"high") at the moment of promotion.
        """
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()

                # Check if meeting exists
                cursor.execute("SELECT id FROM meetings WHERE id = ? OR title = ?", (meeting_id, title))
                existing_meeting = cursor.fetchone()

                if not existing_meeting:
                    # Create new meeting
                    cursor.execute(
                        """
                        INSERT INTO meetings (id, title, created_at, updated_at, detection_source, detection_confidence)
                        VALUES (?, ?, datetime('now'), datetime('now'), ?, ?)
                        """,
                        (meeting_id, title, detection_source, detection_confidence),
                    )
                else:
                    # If we get here and meeting exists, throw error since we don't want duplicates
                    raise Exception(f"Meeting with ID {meeting_id} already exists")
                conn.commit()
                return True
        except Exception as e:
            logger.error(f"Error saving meeting: {str(e)}")
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
        """Get a meeting by ID with all its transcripts"""
        try:
            async with self._get_connection() as conn:
                # Get meeting details
                cursor = await conn.execute("""
                    SELECT id, title, created_at, updated_at
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
                
                return {
                    'id': meeting[0],
                    'title': meeting[1],
                    'created_at': meeting[2],
                    'updated_at': meeting[3],
                    'transcripts': [{
                        'id': meeting_id,
                        'text': transcript[0],
                        'timestamp': transcript[1]
                    } for transcript in transcripts]
                }
        except Exception as e:
            logger.error(f"Error getting meeting: {str(e)}")
            raise

    async def update_meeting_title(self, meeting_id: str, new_title: str):
        """Update a meeting's title"""
        now = datetime.utcnow().isoformat()
        async with self._get_connection() as conn:
            await conn.execute("""
                UPDATE meetings
                SET title = ?, updated_at = ?
                WHERE id = ?
            """, (new_title, now, meeting_id))
            await conn.commit()

    async def get_all_meetings(self):
        """Get all meetings with basic information"""
        async with self._get_connection() as conn:
            cursor = await conn.execute("""
                SELECT id, title, created_at
                FROM meetings
                ORDER BY created_at DESC
            """)
            rows = await cursor.fetchall()
            return [{
                'id': row[0],
                'title': row[1],
                'created_at': row[2]
            } for row in rows]

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


    async def save_api_key(self, api_key: str, provider: str):
        """Save the API key"""
        provider_list = ["openai", "claude", "groq", "ollama"]
        if provider not in provider_list:
            raise ValueError(f"Invalid provider: {provider}")
        if provider == "openai":
            api_key_name = "openaiApiKey"
        elif provider == "claude":
            api_key_name = "anthropicApiKey"
        elif provider == "groq":
            api_key_name = "groqApiKey"
        elif provider == "ollama":
            api_key_name = "ollamaApiKey"
        async with self._get_connection() as conn:
            await conn.execute(f"UPDATE settings SET {api_key_name} = ? WHERE id = '1'", (api_key,))
            await conn.commit()

    async def get_api_key(self, provider: str):
        """Get the API key"""
        provider_list = ["openai", "claude", "groq", "ollama"]
        if provider not in provider_list:
            raise ValueError(f"Invalid provider: {provider}")
        if provider == "openai":
            api_key_name = "openaiApiKey"
        elif provider == "claude":
            api_key_name = "anthropicApiKey"
        elif provider == "groq":
            api_key_name = "groqApiKey"
        elif provider == "ollama":
            api_key_name = "ollamaApiKey"
        async with self._get_connection() as conn:
            cursor = await conn.execute(f"SELECT {api_key_name} FROM settings WHERE id = '1'")
            row = await cursor.fetchone()
            return row[0] if row else None
        
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
        provider_list = ["openai", "claude", "groq", "ollama"]
        if provider not in provider_list:
            raise ValueError(f"Invalid provider: {provider}")
        if provider == "openai":
            api_key_name = "openaiApiKey"
        elif provider == "claude":
            api_key_name = "anthropicApiKey"
        elif provider == "groq":
            api_key_name = "groqApiKey"
        elif provider == "ollama":
            api_key_name = "ollamaApiKey"
        async with self._get_connection() as conn:
            await conn.execute(f"UPDATE settings SET {api_key_name} = NULL WHERE id = '1'")
            await conn.commit()
            
   

