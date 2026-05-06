from fastapi import FastAPI, File, HTTPException, BackgroundTasks, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator, model_validator
import uuid
import uvicorn
from typing import Optional, List
import logging
import os
from dotenv import load_dotenv
from db import DatabaseManager
import io
import json
from threading import Lock
from transcript_processor import TranscriptProcessor
import time
from datetime import datetime, timezone


def serialize_sqlite_timestamp(ts_str):
    """Phase 3 Task 5 fix: convert SQLite's bare `datetime('now')` format
    ("YYYY-MM-DD HH:MM:SS", UTC by SQLite convention but with no
    timezone marker) to ISO 8601 with explicit "+00:00" offset.

    Without the marker, JS `new Date(...)` in V8/Chromium parses the
    string as LOCAL time — for a Houston user (UTC-5) a meeting saved
    at 7:24 PM (stored as May 4 00:24 UTC) re-parses as May 4 00:24
    local, landing in tomorrow's local-day window and mis-bucketing
    in the sidebar.

    Returns None on null input. Pass-through if the input already has
    a timezone marker (T+T or trailing Z / +HH:MM) — defensive against
    backend code paths that already produce ISO-formatted timestamps.
    """
    if not ts_str:
        return None
    s = str(ts_str)
    if 'T' in s or s.endswith('Z') or '+' in s[10:] or s[10:].count('-') > 0:
        # Already looks ISO-ish — leave alone.
        return s
    try:
        dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        return dt.isoformat()  # "2026-05-04T00:24:13+00:00"
    except ValueError:
        # Unknown format — pass through rather than 500.
        logger.warning(f"serialize_sqlite_timestamp: unrecognized format {s!r}")
        return s

# Load environment variables
load_dotenv()

# Configure logger with line numbers and function names
logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)

# Create console handler with formatting
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.DEBUG)

# Create formatter with line numbers and function names
formatter = logging.Formatter(
    '%(asctime)s - %(levelname)s - [%(filename)s:%(lineno)d - %(funcName)s()] - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
console_handler.setFormatter(formatter)

# Add handler to logger if not already added
if not logger.handlers:
    logger.addHandler(console_handler)

app = FastAPI(
    title="Meeting Summarizer API",
    description="API for processing and summarizing meeting transcripts",
    version="1.0.0"
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],     # Allow all origins for testing
    allow_credentials=True,
    allow_methods=["*"],     # Allow all methods
    allow_headers=["*"],     # Allow all headers
    max_age=3600,            # Cache preflight requests for 1 hour
)

# Global database manager instance for meeting management endpoints
db = DatabaseManager()

# New Pydantic models for meeting management
class Transcript(BaseModel):
    id: str
    text: str
    timestamp: str

class TagSummary(BaseModel):
    """Phase 3 Task 7: tag attached to a meeting (no usage_count —
    that's only relevant for the bare /tags endpoint)."""
    id: str
    name: str


class MeetingResponse(BaseModel):
    id: str
    title: str
    # Phase 3 Task 5: surfaced for sidebar date-bucket grouping
    # (Today / Yesterday / This Week / Earlier). Was already selected
    # in get_all_meetings; just wasn't being returned.
    created_at: str
    # Phase 3 Task 7: organization. folder_id is null when the
    # meeting is uncategorized. tags can be empty.
    folder_id: Optional[str] = None
    tags: List[TagSummary] = []

class MeetingDetailsResponse(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str
    # Phase 3 Task 7: same organization fields as the list response.
    folder_id: Optional[str] = None
    tags: List[TagSummary] = []
    transcripts: List[Transcript]

class MeetingTitleUpdate(BaseModel):
    meeting_id: str
    title: str
    # Phase 3 Task 6: reject empty/whitespace-only titles after trim
    # and cap at 200 chars so a runaway client paste doesn't bloat the
    # row. Returns the trimmed value so the DB stores the canonical
    # form (no leading/trailing whitespace).
    @field_validator('title')
    @classmethod
    def title_not_blank(cls, v: str) -> str:
        if v is None:
            raise ValueError('title is required')
        trimmed = v.strip()
        if not trimmed:
            raise ValueError('title cannot be blank')
        if len(trimmed) > 200:
            raise ValueError('title cannot exceed 200 characters')
        return trimmed

class DeleteMeetingRequest(BaseModel):
    meeting_id: str


# ---------- Phase 3 Task 7: folders + tags request models ----------

def _trim_required(field_name: str, max_len: int):
    """Common validator builder: strip whitespace, reject empty, cap
    length. Returns a classmethod suitable for `@field_validator`.
    """
    def validate(cls, v):
        if v is None:
            raise ValueError(f'{field_name} is required')
        trimmed = v.strip()
        if not trimmed:
            raise ValueError(f'{field_name} cannot be blank')
        if len(trimmed) > max_len:
            raise ValueError(f'{field_name} cannot exceed {max_len} characters')
        return trimmed
    return classmethod(validate)


class FolderCreate(BaseModel):
    name: str
    parent_id: Optional[str] = None
    _v_name = field_validator('name')(_trim_required('name', 100))


class FolderUpdate(BaseModel):
    name: str
    _v_name = field_validator('name')(_trim_required('name', 100))


class FolderResponse(BaseModel):
    id: str
    name: str
    parent_id: Optional[str] = None
    created_at: str


class TagCreate(BaseModel):
    name: str
    _v_name = field_validator('name')(_trim_required('name', 50))


class TagResponse(BaseModel):
    id: str
    name: str
    created_at: str
    usage_count: int = 0


class MeetingFolderUpdate(BaseModel):
    """Body for PATCH /meetings/{id}/folder. folder_id=None
    uncategorizes the meeting."""
    folder_id: Optional[str] = None


class MeetingTagAdd(BaseModel):
    """Body for POST /meetings/{id}/tags. Either tag_id (attach an
    existing tag) or name (create-and-attach in one call). Provide
    one or the other; if both are provided, tag_id wins."""
    tag_id: Optional[str] = None
    name: Optional[str] = None

    @model_validator(mode='after')
    def either_id_or_name(self):
        if not self.tag_id and not (self.name and self.name.strip()):
            raise ValueError('Provide either tag_id or a non-empty name')
        if self.name is not None:
            self.name = self.name.strip()
            if self.name and len(self.name) > 50:
                raise ValueError('name cannot exceed 50 characters')
        return self

class SaveTranscriptRequest(BaseModel):
    meeting_title: str
    transcripts: List[Transcript]
    # Phase 2b: optional metadata about how this recording was triggered.
    # Manual recordings omit these and the backend defaults to "manual".
    detection_source: Optional[str] = None
    detection_confidence: Optional[str] = None
    # Phase 2b round 5: optional caller-supplied meeting id. Rust generates
    # this at StartRecording so the frontend can navigate to the right URL
    # before the POST round-trips. If absent, the handler falls back to a
    # server-generated timestamp id.
    meeting_id: Optional[str] = None

class SaveModelConfigRequest(BaseModel):
    provider: str
    model: str
    whisperModel: str
    apiKey: Optional[str] = None

class TranscriptRequest(BaseModel):
    """Request model for transcript text, updated with meeting_id"""
    text: str
    model: str
    model_name: str
    meeting_id: str
    chunk_size: Optional[int] = 5000
    overlap: Optional[int] = 1000

class SummaryProcessor:
    """Handles the processing of summaries in a thread-safe way"""
    def __init__(self):
        try:
            self.db = DatabaseManager()

            logger.info("Initializing SummaryProcessor components")
            self.transcript_processor = TranscriptProcessor()
            logger.info("SummaryProcessor initialized successfully (core components)")
        except Exception as e:
            logger.error(f"Failed to initialize SummaryProcessor: {str(e)}", exc_info=True)
            raise

    async def process_transcript(
        self,
        text: str,
        model: str,
        model_name: str,
        chunk_size: int = 5000,
        overlap: int = 1000,
        custom_prompt: Optional[str] = None,
    ) -> tuple:
        """Process a transcript text"""
        try:
            if not text:
                raise ValueError("Empty transcript text provided")

            # Validate chunk_size and overlap
            if chunk_size <= 0:
                raise ValueError("chunk_size must be positive")
            if overlap < 0:
                raise ValueError("overlap must be non-negative")
            if overlap >= chunk_size:
                overlap = chunk_size - 1  # Ensure overlap is less than chunk_size

            # Ensure step size is positive
            step_size = chunk_size - overlap
            if step_size <= 0:
                chunk_size = overlap + 1  # Adjust chunk_size to ensure positive step

            logger.info(f"Processing transcript of length {len(text)} with chunk_size={chunk_size}, overlap={overlap}")
            num_chunks, all_json_data = await self.transcript_processor.process_transcript(
                text=text,
                model=model,
                model_name=model_name,
                chunk_size=chunk_size,
                overlap=overlap,
                custom_prompt=custom_prompt,
            )
            logger.info(f"Successfully processed transcript into {num_chunks} chunks")

            return num_chunks, all_json_data
        except Exception as e:
            logger.error(f"Error processing transcript: {str(e)}", exc_info=True)
            raise

    def cleanup(self):
        """Cleanup resources"""
        try:
            logger.info("Cleaning up resources")
            if hasattr(self, 'transcript_processor'):
                self.transcript_processor.cleanup()
            logger.info("Cleanup completed successfully")
        except Exception as e:
            logger.error(f"Error during cleanup: {str(e)}", exc_info=True)

# Initialize processor
processor = SummaryProcessor()

# New meeting management endpoints
@app.get("/get-meetings", response_model=List[MeetingResponse])
async def get_meetings():
    """Get all meetings with their basic information"""
    try:
        meetings = await db.get_all_meetings()
        return [
            {
                "id": meeting["id"],
                "title": meeting["title"],
                # Phase 3 Task 5 fix: normalize SQLite's bare timestamp
                # to ISO 8601 with explicit UTC marker so the frontend's
                # date-bucket grouping doesn't mis-parse it as local.
                "created_at": serialize_sqlite_timestamp(meeting["created_at"]),
                # Phase 3 Task 7: organization fields. folder_id may be
                # null (uncategorized); tags may be empty.
                "folder_id": meeting.get("folder_id"),
                "tags": meeting.get("tags", []),
            }
            for meeting in meetings
        ]
    except Exception as e:
        logger.error(f"Error getting meetings: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/get-meeting/{meeting_id}", response_model=MeetingDetailsResponse)
async def get_meeting(meeting_id: str):
    """Get a specific meeting by ID with all its details"""
    try:
        meeting = await db.get_meeting(meeting_id)
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")
        return meeting
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting meeting: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/save-meeting-title")
async def save_meeting_title(data: MeetingTitleUpdate):
    """Save a meeting title.

    Phase 3 Task 6: returns 404 when the meeting_id doesn't exist
    (previously returned 200 even for unknown ids — silent no-op was
    a footgun). The pydantic validator on `title` rejects empty /
    blank / >200-char input with 422 before this handler runs.
    """
    try:
        updated = await db.update_meeting_title(data.meeting_id, data.title)
        if not updated:
            raise HTTPException(
                status_code=404,
                detail=f"Meeting with id {data.meeting_id} not found",
            )
        return {
            "status": "saved",
            "meeting_id": data.meeting_id,
            "title": data.title,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving meeting title: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/delete-meeting")
async def delete_meeting(data: DeleteMeetingRequest):
    """Delete a meeting and all its associated data"""
    try:
        success = await db.delete_meeting(data.meeting_id)
        if success:
            return {"message": "Meeting deleted successfully"}
        else:
            raise HTTPException(status_code=500, detail="Failed to delete meeting")
    except Exception as e:
        logger.error(f"Error deleting meeting: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================
# Phase 3 Task 7: folders + tags
# ============================================================

@app.get("/folders", response_model=List[FolderResponse])
async def list_folders():
    try:
        folders = await db.list_folders()
        return [
            {
                "id": f["id"],
                "name": f["name"],
                "parent_id": f["parent_id"],
                "created_at": serialize_sqlite_timestamp(f["created_at"]),
            }
            for f in folders
        ]
    except Exception as e:
        logger.error(f"Error listing folders: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/folders", response_model=FolderResponse)
async def create_folder(body: FolderCreate):
    folder_id = uuid.uuid4().hex
    try:
        await db.create_folder(folder_id, body.name, body.parent_id)
        # Re-fetch to return the canonical row (created_at populated).
        folders = await db.list_folders()
        for f in folders:
            if f["id"] == folder_id:
                return {
                    "id": f["id"],
                    "name": f["name"],
                    "parent_id": f["parent_id"],
                    "created_at": serialize_sqlite_timestamp(f["created_at"]),
                }
        # Shouldn't happen — the row we just inserted should be there.
        raise HTTPException(status_code=500, detail="Folder created but not found on read-back")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating folder: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/folders/{folder_id}", response_model=FolderResponse)
async def update_folder(folder_id: str, body: FolderUpdate):
    try:
        ok = await db.rename_folder(folder_id, body.name)
        if not ok:
            raise HTTPException(status_code=404, detail=f"Folder {folder_id} not found")
        folders = await db.list_folders()
        for f in folders:
            if f["id"] == folder_id:
                return {
                    "id": f["id"],
                    "name": f["name"],
                    "parent_id": f["parent_id"],
                    "created_at": serialize_sqlite_timestamp(f["created_at"]),
                }
        raise HTTPException(status_code=404, detail=f"Folder {folder_id} not found after rename")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating folder: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/folders/{folder_id}")
async def delete_folder(folder_id: str):
    try:
        ok = await db.delete_folder(folder_id)
        if not ok:
            raise HTTPException(status_code=404, detail=f"Folder {folder_id} not found")
        return {"status": "deleted", "folder_id": folder_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting folder: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/tags", response_model=List[TagResponse])
async def list_tags():
    try:
        tags = await db.list_tags()
        return [
            {
                "id": t["id"],
                "name": t["name"],
                "created_at": serialize_sqlite_timestamp(t["created_at"]),
                "usage_count": t["usage_count"],
            }
            for t in tags
        ]
    except Exception as e:
        logger.error(f"Error listing tags: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/tags", response_model=TagResponse)
async def create_tag(body: TagCreate):
    """Create a tag, or return the existing one if a tag with the
    same case-insensitive name already exists. Idempotent — clients
    can POST the same name repeatedly without 409s."""
    try:
        existing = await db.find_tag_by_name(body.name)
        if existing:
            tags = await db.list_tags()
            for t in tags:
                if t["id"] == existing["id"]:
                    return {
                        "id": t["id"],
                        "name": t["name"],
                        "created_at": serialize_sqlite_timestamp(t["created_at"]),
                        "usage_count": t["usage_count"],
                    }
        tag_id = uuid.uuid4().hex
        await db.create_tag(tag_id, body.name)
        tags = await db.list_tags()
        for t in tags:
            if t["id"] == tag_id:
                return {
                    "id": t["id"],
                    "name": t["name"],
                    "created_at": serialize_sqlite_timestamp(t["created_at"]),
                    "usage_count": t["usage_count"],
                }
        raise HTTPException(status_code=500, detail="Tag created but not found on read-back")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating tag: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/tags/{tag_id}")
async def delete_tag(tag_id: str):
    try:
        ok = await db.delete_tag(tag_id)
        if not ok:
            raise HTTPException(status_code=404, detail=f"Tag {tag_id} not found")
        return {"status": "deleted", "tag_id": tag_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting tag: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/meetings/{meeting_id}/folder")
async def set_meeting_folder(meeting_id: str, body: MeetingFolderUpdate):
    """Assign a meeting to a folder, or pass folder_id=null in the
    body to uncategorize."""
    try:
        # Validate the target folder exists if non-null. ON DELETE SET NULL
        # would normally protect us from dangling refs, but UPDATE doesn't
        # cascade — so check up front.
        if body.folder_id is not None:
            folders = await db.list_folders()
            if not any(f["id"] == body.folder_id for f in folders):
                raise HTTPException(status_code=404, detail=f"Folder {body.folder_id} not found")
        ok = await db.set_meeting_folder(meeting_id, body.folder_id)
        if not ok:
            raise HTTPException(status_code=404, detail=f"Meeting {meeting_id} not found")
        return {
            "status": "saved",
            "meeting_id": meeting_id,
            "folder_id": body.folder_id,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error setting meeting folder: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/meetings/{meeting_id}/tags")
async def add_meeting_tag(meeting_id: str, body: MeetingTagAdd):
    """Attach a tag to a meeting. If `name` is provided (and `tag_id`
    isn't), create-or-find the tag by name (case-insensitive) and
    attach it. Returns the attached tag and the meeting's full tag
    list."""
    try:
        # Ensure the meeting exists. Otherwise the FK check on the
        # junction table would fail silently in our INSERT OR IGNORE
        # path.
        existing_meeting = await db.get_meeting(meeting_id)
        if not existing_meeting:
            raise HTTPException(status_code=404, detail=f"Meeting {meeting_id} not found")

        tag_id = body.tag_id
        if not tag_id:
            # Create-or-find by name.
            existing = await db.find_tag_by_name(body.name)
            if existing:
                tag_id = existing["id"]
            else:
                tag_id = uuid.uuid4().hex
                await db.create_tag(tag_id, body.name)
        else:
            # Validate the tag exists.
            tags = await db.list_tags()
            if not any(t["id"] == tag_id for t in tags):
                raise HTTPException(status_code=404, detail=f"Tag {tag_id} not found")

        ok = await db.add_meeting_tag(meeting_id, tag_id)
        if not ok:
            raise HTTPException(status_code=500, detail="Failed to attach tag")

        meeting_tags = await db.get_meeting_tags(meeting_id)
        attached = next((t for t in meeting_tags if t["id"] == tag_id), None)
        return {
            "status": "attached",
            "meeting_id": meeting_id,
            "tag": attached,
            "tags": meeting_tags,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error adding meeting tag: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/meetings/{meeting_id}/tags/{tag_id}")
async def remove_meeting_tag(meeting_id: str, tag_id: str):
    """Detach a tag from a meeting. The tag itself stays — only the
    junction row is removed."""
    try:
        ok = await db.remove_meeting_tag(meeting_id, tag_id)
        if not ok:
            raise HTTPException(
                status_code=404,
                detail=f"Tag {tag_id} is not attached to meeting {meeting_id}",
            )
        meeting_tags = await db.get_meeting_tags(meeting_id)
        return {
            "status": "detached",
            "meeting_id": meeting_id,
            "tag_id": tag_id,
            "tags": meeting_tags,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error removing meeting tag: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

async def process_transcript_background(process_id: str, transcript: TranscriptRequest):
    """Background task to process transcript"""
    try:
        logger.info(f"Starting background processing for process_id: {process_id}")

        # Phase 4 Task 1B: pull the per-meeting custom summary prompt
        # if one was saved via /meetings/{id}/custom-prompt. The
        # processor appends it to the standard template before each
        # chunk's call so the user's instruction shapes content focus
        # without breaking the JSON schema.
        custom_prompt = None
        try:
            custom_prompt = await processor.db.get_meeting_custom_prompt(transcript.meeting_id)
        except Exception as e:
            logger.warning(
                f"Failed to read custom_summary_prompt for "
                f"{transcript.meeting_id}: {e}"
            )
        if custom_prompt:
            logger.info(
                f"Applying custom summary prompt for {transcript.meeting_id} "
                f"({len(custom_prompt)} chars)"
            )

        num_chunks, all_json_data = await processor.process_transcript(
            text=transcript.text,
            model=transcript.model,
            model_name=transcript.model_name,
            chunk_size=transcript.chunk_size,
            overlap=transcript.overlap,
            custom_prompt=custom_prompt,
        )

        # Create final summary structure by aggregating chunk results
        final_summary = {
            "MeetingName": "",
            "SectionSummary": {"title": "Section Summary", "blocks": []},
            "CriticalDeadlines": {"title": "Critical Deadlines", "blocks": []},
            "KeyItemsDecisions": {"title": "Key Items & Decisions", "blocks": []},
            "ImmediateActionItems": {"title": "Immediate Action Items", "blocks": []},
            "NextSteps": {"title": "Next Steps", "blocks": []},
            "OtherImportantPoints": {"title": "Other Important Points", "blocks": []},
            "ClosingRemarks": {"title": "Closing Remarks", "blocks": []}
        }

        # Process each chunk's data
        for json_str in all_json_data:
            try:
                json_dict = json.loads(json_str)
                if "MeetingName" in json_dict and json_dict["MeetingName"]:
                    final_summary["MeetingName"] = json_dict["MeetingName"]
                for key in final_summary:
                    if key != "MeetingName" and key in json_dict and isinstance(json_dict[key], dict) and "blocks" in json_dict[key]:
                        if isinstance(json_dict[key]["blocks"], list):
                            final_summary[key]["blocks"].extend(json_dict[key]["blocks"])
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse JSON chunk for {process_id}: {e}. Chunk: {json_str[:100]}...")
            except Exception as e:
                logger.error(f"Error processing chunk data for {process_id}: {e}. Chunk: {json_str[:100]}...")

        # Phase 3 Task 8: auto-rename the meeting from the LLM-generated
        # title — but only when the current title is still an
        # `Auto: <App> · <date>` placeholder. If the user has manually
        # renamed via /save-meeting-title (Phase 3 Task 6) before the
        # summary completed, preserve their name. Also skip the LLM's
        # explicit fallback "Untitled meeting" (returned for transcripts
        # too short/silent to title) so the placeholder stays visible
        # rather than being replaced with the literal phrase.
        suggested = (final_summary.get("MeetingName") or "").strip()
        if suggested and suggested.lower() != "untitled meeting":
            current_title = await processor.db.get_meeting_title(transcript.meeting_id)
            if current_title and current_title.startswith("Auto: "):
                await processor.db.update_meeting_name(transcript.meeting_id, suggested)
                logger.info(
                    f"Auto-renamed meeting {transcript.meeting_id}: "
                    f"{current_title!r} -> {suggested!r}"
                )
            elif current_title:
                logger.info(
                    f"Skipping auto-rename for {transcript.meeting_id}: "
                    f"current title {current_title!r} is not an Auto: placeholder"
                )

        # Save final result
        if all_json_data:
            await processor.db.update_process(process_id, status="completed", result=json.dumps(final_summary))
            logger.info(f"Background processing completed for process_id: {process_id}")
        else:
            error_msg = "Summary generation failed: No summary could be generated. Please check your model/API key settings."
            await processor.db.update_process(process_id, status="failed", error=error_msg)
            logger.error(f"Background processing failed for process_id: {process_id} - {error_msg}")

    except Exception as e:
        error_msg = str(e)
        logger.error(f"Error in background processing for {process_id}: {error_msg}", exc_info=True)
        try:
            await processor.db.update_process(process_id, status="failed", error=error_msg)
        except Exception as db_e:
            logger.error(f"Failed to update DB status to failed for {process_id}: {db_e}", exc_info=True)

@app.post("/process-transcript")
async def process_transcript_api(
    transcript: TranscriptRequest,
    background_tasks: BackgroundTasks
):
    """Process a transcript text with background processing"""
    try:
        # Create new process linked to meeting_id
        process_id = await processor.db.create_process(transcript.meeting_id)

        # Save transcript data associated with meeting_id
        await processor.db.save_transcript(
            transcript.meeting_id,
            transcript.text,
            transcript.model,
            transcript.model_name,
            transcript.chunk_size,
            transcript.overlap
        )

        # Start background processing
        background_tasks.add_task(
            process_transcript_background,
            process_id,
            transcript
        )

        return JSONResponse({
            "message": "Processing started",
            "process_id": process_id
        })

    except Exception as e:
        logger.error(f"Error in process_transcript_api: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/get-summary/{meeting_id}")
async def get_summary(meeting_id: str):
    """Get the summary for a given meeting ID"""
    try:
        result = await processor.db.get_transcript_data(meeting_id)
        if not result:
            return JSONResponse(
                status_code=404,
                content={
                    "status": "error",
                    "meetingName": None,
                    "meeting_id": meeting_id,
                    "data": None,
                    "start": None,
                    "end": None,
                    "error": "Meeting ID not found"
                }
            )

        status = result.get("status", "unknown").lower()

        # Parse result data if available
        summary_data = None
        if result.get("result"):
            try:
                parsed_result = json.loads(result["result"])
                if isinstance(parsed_result, str):
                    summary_data = json.loads(parsed_result)
                else:
                    summary_data = parsed_result
                if not isinstance(summary_data, dict):
                    logger.error(f"Parsed summary data is not a dictionary for meeting {meeting_id}")
                    summary_data = None
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse JSON data for meeting {meeting_id}: {str(e)}")
                status = "failed"
                result["error"] = f"Invalid summary data format: {str(e)}"
            except Exception as e:
                logger.error(f"Unexpected error parsing summary data for {meeting_id}: {str(e)}")
                status = "failed"
                result["error"] = f"Error processing summary data: {str(e)}"

        response = {
            "status": "processing" if status in ["processing", "pending", "started"] else status,
            "meetingName": summary_data.get("MeetingName") if isinstance(summary_data, dict) else None,
            "meeting_id": meeting_id,
            "start": result.get("start_time"),
            "end": result.get("end_time"),
            "data": summary_data if status == "completed" else None
        }

        if status == "failed":
            response["status"] = "error"
            response["error"] = result.get("error", "Unknown processing error")
            response["data"] = None
            response["meetingName"] = None
            return JSONResponse(status_code=400, content=response)

        elif status in ["processing", "pending", "started"]:
            response["data"] = None
            return JSONResponse(status_code=202, content=response)

        elif status == "completed":
            if not summary_data:
                response["status"] = "error"
                response["error"] = "Completed but summary data is missing or invalid"
                response["data"] = None
                response["meetingName"] = None
                return JSONResponse(status_code=500, content=response)
            return JSONResponse(status_code=200, content=response)

        else:
            response["status"] = "error"
            response["error"] = f"Unknown or unexpected status: {status}"
            response["data"] = None
            response["meetingName"] = None
            return JSONResponse(status_code=500, content=response)

    except Exception as e:
        logger.error(f"Error getting summary for {meeting_id}: {str(e)}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={
                "status": "error",
                "meetingName": None,
                "meeting_id": meeting_id,
                "data": None,
                "start": None,
                "end": None,
                "error": f"Internal server error: {str(e)}"
            }
        )

@app.post("/save-transcript")
async def save_transcript(request: SaveTranscriptRequest):
    """Save transcript segments for a meeting.

    Phase 2b round 5:
      * Honors request.meeting_id if provided (Rust generates it at
        StartRecording so the frontend can navigate to the right URL).
        Falls back to a server-generated timestamp id otherwise.
      * Idempotent on id collision: same id → update existing row +
        replace its transcripts. This is what Rust retries (current or
        future) need.
      * Title is no longer a uniqueness constraint. Two recordings with
        the same auto-title ("Auto: Google Meet") are legitimate.
    """
    try:
        meeting_id = request.meeting_id or f"meeting-{int(time.time() * 1000)}"
        logger.info(
            f"Received save-transcript request: meeting_id={meeting_id}, "
            f"title={request.meeting_title!r}, "
            f"transcripts={len(request.transcripts)}, "
            f"source={request.detection_source}, "
            f"confidence={request.detection_confidence}"
        )

        # Upsert the meeting row (idempotent on id).
        await db.upsert_meeting(
            meeting_id,
            request.meeting_title,
            detection_source=request.detection_source or "manual",
            detection_confidence=request.detection_confidence or "manual",
        )

        # Replace transcripts for this meeting (idempotent on retry).
        # The request body is the source of truth for this meeting_id.
        await db.delete_meeting_transcripts(meeting_id)
        for transcript in request.transcripts:
            await db.save_meeting_transcript(
                meeting_id=meeting_id,
                transcript=transcript.text,
                timestamp=transcript.timestamp,
                summary="",
                action_items="",
                key_points=""
            )

        logger.info(f"Transcripts saved successfully for {meeting_id}")
        return {"status": "saved", "meeting_id": meeting_id}
    except Exception as e:
        logger.error(f"Error saving transcript: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/transcribe-audio")
async def transcribe_audio(file: UploadFile = File(...)):
    """Phase 4 Task 1C: transcribe a recorded WAV using Gemini 2.5 Flash.

    The Rust audio pipeline calls this once at end-of-recording with
    the full mixed mic+system audio as a WAV upload. Replaces the
    previous local whisper-cpp transcription on port 8178.

    Returns ``{"transcript": "<full text>"}`` on success. Empty bodies
    are valid (e.g. a recording that captured only silence).
    """
    # Lazy-import inside the handler so module load doesn't depend on
    # google-genai when transcription is disabled in some future build.
    from google import genai
    from google.genai import types as genai_types

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        # Fall back to the DB-stored key (the eventual Settings UI in
        # Task 1B will manage this), then 503 if neither is configured.
        try:
            api_key = await db.get_api_key("gemini")
        except Exception:
            api_key = None
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail=(
                "GEMINI_API_KEY not configured. Set the GEMINI_API_KEY "
                "environment variable in backend/.env to enable transcription."
            ),
        )

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio upload")

    logger.info(
        f"/transcribe-audio: received {len(audio_bytes)} bytes "
        f"(content_type={file.content_type!r}, filename={file.filename!r})"
    )

    client = genai.Client(api_key=api_key)

    # The Files API is the recommended path for non-trivial audio.
    # Inline base64 only works for very short clips (<20MB request
    # size limit including overhead). Files API has a 48-hour TTL
    # and we delete after each call to stay within quota.
    uploaded = await client.aio.files.upload(
        file=io.BytesIO(audio_bytes),
        config={"mime_type": "audio/wav"},
    )
    logger.info(f"/transcribe-audio: uploaded as {uploaded.name}")

    prompt = (
        "Transcribe this meeting audio accurately and verbatim. "
        "If multiple speakers are present, label them as Speaker 1, "
        "Speaker 2, etc. and start each speaker turn on a new line "
        "prefixed with 'Speaker N: '. Do NOT add timestamps. Do NOT "
        "summarize or paraphrase. If the audio contains music, "
        "silence, or non-speech, indicate that briefly in brackets "
        "like [music] or [silence]. Output ONLY the transcript text — "
        "no preamble, no commentary."
    )

    # Phase 5 Task 1: wrap the Gemini call in @with_retry so transient
    # 503/UNAVAILABLE responses auto-retry up to 3 times before failing
    # the upload. The Files-API delete in `finally` still fires.
    from gemini_retry import with_retry as _with_retry  # noqa: E402

    @_with_retry
    async def _do_generate():
        return await client.aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=[prompt, uploaded],
            config=genai_types.GenerateContentConfig(
                temperature=0.0,
            ),
        )

    try:
        response = await _do_generate()
        transcript_text = (response.text or "").strip()
        logger.info(
            f"/transcribe-audio: Gemini returned {len(transcript_text)} chars"
        )
        return {"transcript": transcript_text}
    except Exception as e:
        logger.exception("Gemini transcription failed")
        # Phase 5 Task 1: friendly Gemini error mapping (same pattern
        # as the summary path). Surface a human-readable message
        # instead of the raw SDK class name.
        import google.genai.errors as _gemini_errors  # noqa: E402

        if isinstance(e, _gemini_errors.ServerError):
            status = (
                getattr(e, "code", None)
                or getattr(e, "status_code", None)
                or "5xx"
            )
            raise HTTPException(
                status_code=502,
                detail=(
                    f"Gemini transcription is temporarily unavailable "
                    f"(HTTP {status}). Please try again in a moment."
                ),
            )
        if isinstance(e, _gemini_errors.ClientError):
            raise HTTPException(
                status_code=502,
                detail=f"Gemini rejected the audio: {e}",
            )
        raise HTTPException(
            status_code=502,
            detail=f"Gemini transcription failed: {type(e).__name__}: {str(e)[:300]}",
        )
    finally:
        # Always clean up the uploaded file. Catch + log any cleanup
        # error so it doesn't mask the primary success/failure.
        try:
            await client.aio.files.delete(name=uploaded.name)
        except Exception as cleanup_err:
            logger.warning(
                f"/transcribe-audio: failed to delete uploaded file "
                f"{uploaded.name}: {cleanup_err}"
            )


@app.get("/llm/models")
async def list_llm_models():
    """Phase 4 Task 1A: enumerate available summarisation models.

    Replaces the frontend's old direct call to Ollama's
    `localhost:11434/api/tags`. Currently returns a single hardcoded
    Gemini option since that's the bundled provider; once Task 1B
    adds the user-managed Settings UI for other providers, this can
    enumerate per the configured keys.
    """
    return {
        "provider": "gemini",
        "default": "gemini-2.5-flash",
        "models": [
            {
                "name": "gemini-2.5-flash",
                "id": "gemini-2.5-flash",
                "label": "Gemini 2.5 Flash (default)",
            },
        ],
    }

@app.get("/get-model-config")
async def get_model_config():
    """Get the current model configuration"""
    model_config = await db.get_model_config()
    api_key = await db.get_api_key(model_config["provider"])
    if api_key != None:
        model_config["apiKey"] = api_key
    return model_config

@app.post("/save-model-config")
async def save_model_config(request: SaveModelConfigRequest):
    """Save the model configuration"""
    await db.save_model_config(request.provider, request.model, request.whisperModel)
    if request.apiKey != None:
        await db.save_api_key(request.apiKey, request.provider)
    return {"status": "success", "message": "Model configuration saved successfully"}  

class GetApiKeyRequest(BaseModel):
    provider: str

@app.post("/get-api-key")
async def get_api_key(request: GetApiKeyRequest):
    """Get the API key for a given provider"""
    return await db.get_api_key(request.provider)




# ===== Phase 2a: recording settings =====

class RecordingSettingsResponse(BaseModel):
    auto_record_enabled: bool
    has_seen_onboarding: bool

class RecordingSettingsUpdate(BaseModel):
    auto_record_enabled: Optional[bool] = None
    has_seen_onboarding: Optional[bool] = None

@app.get("/settings/recording", response_model=RecordingSettingsResponse)
async def get_recording_settings():
    """Get auto-record + onboarding settings."""
    return await db.get_recording_settings()

@app.post("/settings/recording", response_model=RecordingSettingsResponse)
async def set_recording_settings(payload: RecordingSettingsUpdate):
    """Update auto-record and/or onboarding settings."""
    await db.set_recording_settings(
        auto_record_enabled=payload.auto_record_enabled,
        has_seen_onboarding=payload.has_seen_onboarding,
    )
    return await db.get_recording_settings()


# ===== Phase 4 Task 1B: app-level Settings page =====

# Hardcoded for v1 (single-tenant bundled key model). Returned in
# /settings.about so the Settings page can render provider info
# without a separate API surface.
_APP_VERSION = "0.4.0"
_TRANSCRIPTION_PROVIDER_LABEL = "Gemini 2.5 Flash"
_SUMMARY_PROVIDER_LABEL = "Gemini 2.5 Flash"


class SettingsAboutBlock(BaseModel):
    version: str
    transcription_provider: str
    summary_provider: str


class AppSettingsResponse(BaseModel):
    auto_record_enabled: bool
    auto_record_sources: List[str]
    default_folder_id: Optional[str] = None
    theme: str
    about: SettingsAboutBlock


class AppSettingsUpdate(BaseModel):
    """Phase 4 Task 1B: partial update — every field is Optional. The
    frontend sends only what changed, debounce-friendly.

    `default_folder_id`'s tri-state (set / clear / leave) is encoded
    via Pydantic's "field set" tracking: explicitly passing
    ``"default_folder_id": null`` clears the column; omitting the
    field leaves it untouched. We detect the difference in the
    handler with `model_fields_set`.
    """
    auto_record_enabled: Optional[bool] = None
    auto_record_sources: Optional[List[str]] = None
    default_folder_id: Optional[str] = None
    theme: Optional[str] = None


def _build_about() -> SettingsAboutBlock:
    return SettingsAboutBlock(
        version=_APP_VERSION,
        transcription_provider=_TRANSCRIPTION_PROVIDER_LABEL,
        summary_provider=_SUMMARY_PROVIDER_LABEL,
    )


@app.get("/settings", response_model=AppSettingsResponse)
async def get_app_settings():
    """Read the user-facing settings (Phase 4 Task 1B)."""
    payload = await db.get_app_settings()
    payload["about"] = _build_about()
    return payload


@app.patch("/settings", response_model=AppSettingsResponse)
async def update_app_settings(payload: AppSettingsUpdate):
    """Partial update for the Settings page. Returns the post-update
    settings so the frontend can rehydrate without a follow-up GET.

    Notes:
    - ``default_folder_id: null`` clears the column (Uncategorized).
    - ``auto_record_sources`` is fully replaced (not merged); send the
      complete list every time. Empty list = no auto-record sources.
    - ``theme`` accepts only ``light`` / ``dark`` / ``system``.
    """
    fields_set = payload.model_fields_set
    try:
        result = await db.update_app_settings(
            auto_record_enabled=payload.auto_record_enabled,
            auto_record_sources=payload.auto_record_sources,
            default_folder_id=payload.default_folder_id,
            clear_default_folder=(
                "default_folder_id" in fields_set
                and payload.default_folder_id is None
            ),
            theme=payload.theme,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    result["about"] = _build_about()
    return result


# ===== Phase 4 Task 1D: shared Gemini API-key resolver ============

async def _resolve_gemini_api_key() -> Optional[str]:
    """Phase 4 Task 1D: env first, DB second. Used by every Gemini-
    facing endpoint (transcribe, enhance) so the resolution rules
    stay in one place."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if api_key:
        return api_key
    try:
        return await db.get_api_key("gemini")
    except Exception:
        return None


# ===== Phase 4 Task 1B: per-meeting custom summary prompt =====

class MeetingCustomPromptUpdate(BaseModel):
    """Send `prompt: null` (or omit a non-null field) to clear the
    saved custom prompt. Send a non-empty string to set/replace it.
    Whitespace-only strings are normalised to None — the backend
    treats them the same as cleared."""
    prompt: Optional[str] = None


@app.get("/meetings/{meeting_id}/custom-prompt")
async def get_meeting_custom_prompt(meeting_id: str):
    """Read the per-meeting custom summary prompt (Phase 4 Task 1B)."""
    prompt = await db.get_meeting_custom_prompt(meeting_id)
    if prompt is None:
        # Distinguish "no prompt set" (200, null) from "no such
        # meeting" (404). Cheap existence check via the existing
        # title fetch.
        title = await db.get_meeting_title(meeting_id)
        if title is None:
            raise HTTPException(status_code=404, detail="Meeting not found")
    return {"meeting_id": meeting_id, "prompt": prompt}


@app.patch("/meetings/{meeting_id}/custom-prompt")
async def set_meeting_custom_prompt(
    meeting_id: str, payload: MeetingCustomPromptUpdate
):
    """Set or clear the per-meeting custom summary prompt."""
    cleaned: Optional[str] = None
    if payload.prompt is not None:
        stripped = payload.prompt.strip()
        cleaned = stripped if stripped else None
    updated = await db.update_meeting_custom_prompt(meeting_id, cleaned)
    if not updated:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return {"meeting_id": meeting_id, "prompt": cleaned}


# ===== Phase 4 Task 1D: saved prompt library =====

class SavedPrompt(BaseModel):
    id: int
    name: str
    category: str
    prompt_text: str
    is_starter: bool
    created_at: str
    use_count: int


class SavedPromptCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    category: str = Field(min_length=1, max_length=40)
    prompt_text: str = Field(min_length=1, max_length=4000)

    @field_validator("name", "category", "prompt_text")
    @classmethod
    def _trim_non_blank(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped


class EnhancePromptRequest(BaseModel):
    prompt_text: str = Field(min_length=1, max_length=4000)


class EnhancePromptResponse(BaseModel):
    enhanced: str


@app.get("/saved-prompts", response_model=List[SavedPrompt])
async def list_saved_prompts():
    """Return every saved prompt, ordered by category then name.

    The frontend groups by category client-side so the dropdown can
    render <optgroup> sections without an extra round-trip.
    """
    return await db.list_saved_prompts()


@app.post("/saved-prompts", response_model=SavedPrompt, status_code=201)
async def create_saved_prompt(payload: SavedPromptCreate):
    """Create a user-authored saved prompt. is_starter is always 0
    (the migration's seed is the only path that sets it)."""
    return await db.create_saved_prompt(
        name=payload.name,
        category=payload.category,
        prompt_text=payload.prompt_text,
    )


@app.delete("/saved-prompts/{prompt_id}", status_code=204)
async def delete_saved_prompt(prompt_id: int):
    """Delete any saved prompt by id. Starters are deletable on
    purpose — the seed only fires when the is_starter set is empty,
    so a deleted starter stays gone."""
    deleted = await db.delete_saved_prompt(prompt_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Saved prompt not found")
    return None


@app.post("/saved-prompts/{prompt_id}/use", status_code=204)
async def increment_saved_prompt_use(prompt_id: int):
    """Bump use_count for a saved prompt. The frontend calls this
    after a successful Save & Regenerate iff the textarea content
    matched the picked saved prompt verbatim. Best-effort: a 404
    here just means the prompt was deleted concurrently — not a
    user-facing error."""
    await db.increment_saved_prompt_use_count(prompt_id)
    return None


@app.post("/saved-prompts/enhance", response_model=EnhancePromptResponse)
async def enhance_saved_prompt(payload: EnhancePromptRequest):
    """Phase 4 Task 1D: Gemini rewrites the user's rough prompt into
    a clearer, tighter version that preserves intent. Used by the
    ✨ Enhance button in the CustomSummaryPromptModal.

    Returns 503 when no Gemini key is configured (same shape as
    /transcribe-audio); 502 on Gemini failure.
    """
    from google import genai
    from google.genai import types as genai_types

    api_key = await _resolve_gemini_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail=(
                "GEMINI_API_KEY not configured. Set the GEMINI_API_KEY "
                "environment variable in backend/.env to enable enhancing."
            ),
        )

    system_instruction = (
        "You are an expert at writing clear, actionable instructions for an "
        "AI meeting summarizer. The user has written a rough instruction for "
        "how they want their meeting summarized. Rewrite it to be clearer, "
        "more specific, and more actionable while strictly preserving their "
        "intent. Do NOT add requirements they did not imply. Keep the "
        "rewrite under 100 words. Output ONLY the rewritten instruction "
        "with no preamble, no markdown formatting, and no surrounding "
        "quotes."
    )

    client = genai.Client(api_key=api_key)

    # Phase 5 Task 1: wrap with @with_retry so transient Gemini 503s
    # auto-retry up to 3 times before failing the click.
    from gemini_retry import with_retry as _with_retry  # noqa: E402

    @_with_retry
    async def _do_enhance():
        return await client.aio.models.generate_content(
            model="gemini-2.5-flash",
            contents=[
                system_instruction,
                f"Original instruction:\n{payload.prompt_text.strip()}",
            ],
            config=genai_types.GenerateContentConfig(temperature=0.3),
        )

    try:
        response = await _do_enhance()
    except Exception as exc:
        logger.exception("Gemini enhance call failed")
        # Phase 5 Task 1: friendly Gemini error mapping.
        import google.genai.errors as _gemini_errors  # noqa: E402

        if isinstance(exc, _gemini_errors.ServerError):
            status = (
                getattr(exc, "code", None)
                or getattr(exc, "status_code", None)
                or "5xx"
            )
            raise HTTPException(
                status_code=502,
                detail=(
                    f"Gemini is temporarily unavailable for prompt "
                    f"enhancement (HTTP {status}). Please try again in a "
                    "moment."
                ),
            )
        if isinstance(exc, _gemini_errors.ClientError):
            raise HTTPException(
                status_code=502,
                detail=f"Gemini rejected the enhancement request: {exc}",
            )
        raise HTTPException(
            status_code=502,
            detail=f"Gemini enhance failed: {type(exc).__name__}: {str(exc)[:300]}",
        )

    enhanced = (response.text or "").strip()
    # Defensive: strip surrounding quotes if Gemini wrapped its output
    # despite the "no surrounding quotes" instruction.
    if (
        len(enhanced) >= 2
        and enhanced[0] in ("'", '"', "“")
        and enhanced[-1] in ("'", '"', "”")
    ):
        enhanced = enhanced[1:-1].strip()
    if not enhanced:
        # Treat empty-after-strip as a Gemini glitch rather than 200ing
        # back something the UI can't render usefully.
        raise HTTPException(
            status_code=502, detail="Gemini returned an empty enhancement"
        )
    return EnhancePromptResponse(enhanced=enhanced)


@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on API shutdown"""
    logger.info("API shutting down, cleaning up resources")
    try:
        processor.cleanup()
        logger.info("Successfully cleaned up resources")
    except Exception as e:
        logger.error(f"Error during cleanup: {str(e)}", exc_info=True)

if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    uvicorn.run(app, host="0.0.0.0", port=5167)
