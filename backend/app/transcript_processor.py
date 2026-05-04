from pydantic import BaseModel
from typing import List, Optional, Tuple
# Phase 4 Task 1A: Gemini is the new default LLM provider. We use the
# google-genai SDK directly rather than going through pydantic-ai
# because (a) pydantic-ai 0.0.19 has no Gemini provider class, and
# (b) google-genai's response_schema=<pydantic class> already gives
# us the strict structured output that pydantic-ai's Agent provides
# for the other models — so the wrapper would be redundant.
#
# pydantic-ai is also now an optional dependency: a Gemini-only install
# (the bundled default) does not need it. We lazy-import inside the
# claude/groq/openai branches so a missing pydantic-ai doesn't break
# module import — it only surfaces when the user actually picks one of
# those providers.
from google import genai
from google.genai import types as genai_types
import json
import logging
import os
from dotenv import load_dotenv
from db import DatabaseManager





# Set up logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(levelname)s - [%(filename)s:%(lineno)d] - %(message)s'
)
logger = logging.getLogger(__name__)

load_dotenv()  # Load environment variables from .env file

db = DatabaseManager()

class Block(BaseModel):
    """Represents a block of content in a section"""
    id: str
    type: str
    content: str
    color: str

class Section(BaseModel):
    """Represents a section in the meeting summary"""
    title: str
    blocks: List[Block]

class SummaryResponse(BaseModel):
    """Represents the meeting summary response based on a section of the transcript"""
    MeetingName : str
    SectionSummary : Section
    CriticalDeadlines: Section
    KeyItemsDecisions: Section
    ImmediateActionItems: Section
    NextSteps: Section
    OtherImportantPoints: Section
    ClosingRemarks: Section


# Phase 3 Task 7.5 prompt — kept verbatim across the Phase 4 Gemini swap.
# Both pydantic-ai (claude/groq/openai) and direct google-genai (gemini)
# code paths format this with the chunk text. The schema directive at the
# top of each section keeps the model from padding empty sections, which
# is what enables the frontend's "hide empty sections" filter to surface
# meaningful blanks rather than visual clutter.
_SUMMARY_PROMPT_TEMPLATE = """You are summarizing a chunk of a meeting transcript into the required JSON structure.

Sections (each is independent — only fill what is actually supported by the transcript):
- MeetingName: a short, descriptive title (4-8 words). Leave blank if the chunk gives no clear topic.
- SectionSummary: 2-5 bullets capturing what was discussed in this chunk. Each bullet is one concrete idea, not a paraphrase of small talk.
- CriticalDeadlines: dates / hard deadlines explicitly stated. Format like "Ship by Fri 2026-05-15 — <what>".
- KeyItemsDecisions: decisions actually made (not options considered). Lead with the verb: "Decided to ...", "Agreed that ...".
- ImmediateActionItems: tasks with an owner and (where stated) a due date. Format: "<Owner>: <action> [by <date>]". Skip the brackets if no date.
- NextSteps: follow-ups discussed but not yet owned, or scheduled future activity (e.g. "Schedule follow-up with vendor X next week").
- OtherImportantPoints: substantive context that doesn't fit above (risks, blockers, dependencies, important numbers).
- ClosingRemarks: only if the chunk genuinely contains a wrap-up. Do not invent one.

Rules:
- Be concise. Each bullet should stand alone and be specific.
- Do NOT pad. If a section has no support in this chunk, return blocks: []. Empty is correct, not a failure.
- Do NOT repeat the same point across sections.
- Skip greetings, filler, and off-topic chatter.
- Output ONLY the JSON — no preamble, no commentary.

For each `Section`, the JSON shape is:
  {{ "title": "<section title>", "blocks": [ {{ "id": "<unique-id>", "type": "bullet", "content": "<bullet text>", "color": "default" }}, ... ] }}

Use blocks: [] for empty sections.

Transcript Chunk:
---
{chunk}
---
"""

# --- Main Class Used by main.py ---

class TranscriptProcessor:
    """Handles the processing of meeting transcripts using AI models."""
    def __init__(self):
        """Initialize the transcript processor."""
        logger.info("TranscriptProcessor initialized.")
        self.db = DatabaseManager()
    async def process_transcript(self, text: str, model: str, model_name: str, chunk_size: int = 5000, overlap: int = 1000) -> Tuple[int, List[str]]:
        """
        Process transcript text into chunks and generate structured summaries for each chunk using an AI model.

        Args:
            text: The transcript text.
            model: The AI model provider ('gemini', 'claude', 'groq', 'openai').
            model_name: The specific model name.
            chunk_size: The size of each text chunk.
            overlap: The overlap between consecutive chunks.

        Returns:
            A tuple containing:
            - The number of chunks processed.
            - A list of JSON strings, where each string is the summary of a chunk.
        """

        logger.info(f"Processing transcript (length {len(text)}) with model provider={model}, model_name={model_name}, chunk_size={chunk_size}, overlap={overlap}")

        all_json_data = []
        agent = None
        gemini_client = None

        try:
            # Select and initialize the AI client/agent.
            if model == "gemini":
                # Phase 4 Task 1A: env var wins over the DB-stored key. The
                # env path is the bootstrap config (set on first install
                # via .env); the DB path is for the user-managed Settings
                # UI (Task 1B). Either one is enough — only the union
                # being empty is a hard error.
                api_key = os.environ.get("GEMINI_API_KEY") or await db.get_api_key("gemini")
                if not api_key:
                    raise ValueError(
                        "GEMINI_API_KEY not configured. Set the GEMINI_API_KEY "
                        "environment variable in backend/.env to enable summary generation."
                    )
                gemini_client = genai.Client(api_key=api_key)
                logger.info(f"Using Gemini model: {model_name}")
            elif model in ("claude", "groq", "openai"):
                # Lazy-import pydantic-ai: only required when one of these
                # legacy providers is actually selected. Surfaces a clear
                # error if pydantic-ai isn't installed instead of breaking
                # module load for the (much more common) Gemini path.
                try:
                    from pydantic_ai import Agent
                except ImportError as ie:
                    raise ValueError(
                        f"Provider '{model}' requires pydantic-ai. "
                        f"Install it with `pip install pydantic-ai==0.0.19` "
                        f"or switch to the bundled 'gemini' provider."
                    ) from ie
                if model == "claude":
                    from pydantic_ai.models.anthropic import AnthropicModel
                    api_key = await db.get_api_key("claude")
                    if not api_key: raise ValueError("ANTHROPIC_API_KEY environment variable not set")
                    llm = AnthropicModel(model_name, api_key=api_key)
                    logger.info(f"Using Claude model: {model_name}")
                elif model == "groq":
                    from pydantic_ai.models.groq import GroqModel
                    api_key = await db.get_api_key("groq")
                    if not api_key: raise ValueError("GROQ_API_KEY environment variable not set")
                    llm = GroqModel(model_name, api_key=api_key)
                    logger.info(f"Using Groq model: {model_name}")
                else:  # openai
                    from pydantic_ai.models.openai import OpenAIModel
                    api_key = await db.get_api_key("openai")
                    if not api_key: raise ValueError("OPENAI_API_KEY environment variable not set")
                    llm = OpenAIModel(model_name, api_key=api_key)
                    logger.info(f"Using OpenAI model: {model_name}")
                agent = Agent(llm, result_type=SummaryResponse, result_retries=5)
            else:
                logger.error(f"Unsupported model provider requested: {model}")
                raise ValueError(f"Unsupported model provider: {model}")

            # Split transcript into chunks
            step = chunk_size - overlap
            if step <= 0:
                logger.warning(f"Overlap ({overlap}) >= chunk_size ({chunk_size}). Adjusting overlap.")
                overlap = max(0, chunk_size - 100)
                step = chunk_size - overlap

            chunks = [text[i:i+chunk_size] for i in range(0, len(text), step)]
            num_chunks = len(chunks)
            logger.info(f"Split transcript into {num_chunks} chunks.")

            # Phase 4 Task 1A: capture the last per-chunk error so we can
            # raise it after the loop if EVERY chunk failed. Otherwise the
            # caller only sees the generic "no chunks succeeded" message
            # and has no way to tell a 503 (rate limit) from a bad key
            # from a network blip.
            last_chunk_error: Optional[Exception] = None

            for i, chunk in enumerate(chunks):
                logger.info(f"Processing chunk {i+1}/{num_chunks}...")
                prompt = _SUMMARY_PROMPT_TEMPLATE.format(chunk=chunk)
                try:
                    if model == "gemini":
                        # Direct google-genai call. response_schema=SummaryResponse
                        # tells Gemini to emit JSON conforming to that pydantic
                        # class — equivalent to pydantic-ai's result_type wiring
                        # but native to the SDK. response.text is the raw JSON
                        # string, which is exactly the shape we already store.
                        response = await gemini_client.aio.models.generate_content(
                            model=model_name,
                            contents=prompt,
                            config=genai_types.GenerateContentConfig(
                                # Lower temperature → more consistent structured
                                # output. The summarisation task does not benefit
                                # from creativity.
                                temperature=0.3,
                                response_mime_type="application/json",
                                response_schema=SummaryResponse,
                            ),
                        )
                        chunk_summary_json = response.text
                        # Validate it parses; surface a useful error if Gemini
                        # ever ignores the schema (shouldn't happen with
                        # response_schema set, but cheap insurance).
                        json.loads(chunk_summary_json)
                        all_json_data.append(chunk_summary_json)
                        logger.info(f"Successfully generated summary for chunk {i+1} via Gemini.")
                    else:
                        summary_result = await agent.run(prompt)
                        if hasattr(summary_result, 'data') and isinstance(summary_result.data, SummaryResponse):
                             final_summary_pydantic = summary_result.data
                        elif isinstance(summary_result, SummaryResponse):
                             final_summary_pydantic = summary_result
                        else:
                             logger.error(f"Unexpected result type from agent for chunk {i+1}: {type(summary_result)}")
                             continue
                        chunk_summary_json = final_summary_pydantic.model_dump_json()
                        all_json_data.append(chunk_summary_json)
                        logger.info(f"Successfully generated summary for chunk {i+1}.")

                except Exception as chunk_error:
                    last_chunk_error = chunk_error
                    logger.error(f"Error processing chunk {i+1}: {chunk_error}", exc_info=True)

            logger.info(f"Finished processing all {num_chunks} chunks.")
            if not all_json_data and last_chunk_error is not None:
                # Bubble up the most recent chunk failure so the user sees
                # the real cause (e.g. "Gemini 503 UNAVAILABLE: high
                # demand") instead of the generic fallback the caller
                # produces when the result list is empty.
                raise type(last_chunk_error)(
                    f"All {num_chunks} chunk(s) failed. Last error: {last_chunk_error}"
                ) from last_chunk_error
            return num_chunks, all_json_data

        except Exception as e:
            logger.error(f"Error during transcript processing: {str(e)}", exc_info=True)
            raise