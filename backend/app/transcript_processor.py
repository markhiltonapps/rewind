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
import google.genai.errors as gemini_errors
import json
import logging
import os
from dotenv import load_dotenv
from db import DatabaseManager
from gemini_retry import with_retry





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
    """Represents the meeting summary response based on a section of the transcript.

    Field order matters: it is passed to Gemini as a response_schema, and
    the frontend renders Object.entries(summary) in order, so this is
    also the on-screen section order. Keep it aligned with
    SUMMARY_SECTIONS in cloud/proxy/app/gemini.py -- that copy is the one
    the shipped app actually uses.
    """
    MeetingName : str
    BottomLine: Section
    SectionSummary : Section
    KeyItemsDecisions: Section
    ImmediateActionItems: Section
    OpenQuestions: Section
    ProblemsSolutions: Section
    CriticalDeadlines: Section
    NextSteps: Section
    Participants: Section
    MeetingTone: Section
    OtherImportantPoints: Section
    ClosingRemarks: Section


# Phase 3 Task 7.5 prompt — kept verbatim across the Phase 4 Gemini swap.
# Both pydantic-ai (claude/groq/openai) and direct google-genai (gemini)
# code paths format this with the chunk text. The schema directive at the
# top of each section keeps the model from padding empty sections, which
# is what enables the frontend's "hide empty sections" filter to surface
# meaningful blanks rather than visual clutter.
_SUMMARY_PROMPT_TEMPLATE = """You are an expert meeting analyst. Summarize the meeting transcript below into the required JSON structure.

Your summary serves four readers at once: a participant wanting a fast recap, an executive who skipped the meeting, a project team tracking commitments, and the permanent record. Write so each of them finds what they need.

Sections (each independent -- fill only what the transcript actually supports):

- MeetingName: a concise 4-7 word noun-phrase title capturing what the meeting was actually about. Title Case. Examples of the right shape:
    "Prototype Review, Manufacturing & WMS Integration"
    "Sprint Planning with Ali"
    "Q3 Strategy Review"
    "Customer Onboarding - Acme Corp"
  Avoid generic titles like "Meeting", "Discussion", "Sync", "Call". Do not start with "Meeting on..." or "Call about...". If the transcript is too short, silent, or off-topic to determine a real subject, return exactly "Untitled meeting".

- BottomLine: REQUIRED -- never leave this empty. Exactly ONE block containing one or two sentences with the single most consequential outcome: the thing a busy executive must know if they read nothing else. Lead with the outcome, not the topic. Write "Ops will absorb the Q3 shortfall by delaying the Denver hire until October", not "The team discussed hiring and budget". This is a synthesis of the whole meeting, not a quote from it, so the "only include what the transcript supports" rule does not mean you may skip it. If the meeting reached no decision, say what it was for and what remains unresolved -- e.g. "Exploratory vendor call; no commitments made, pricing still unknown pending their quote."

- Participants: one block per identifiable person, formatted "<Name> -- <their role or main contribution in this meeting>". Use real names when spoken or self-introduced. If speakers are only "Speaker 1"/"Speaker 2", still list them with what they contributed ("Speaker 2 -- raised the pricing objection, owns vendor follow-up"). Return blocks: [] only if there is genuinely nothing to distinguish speakers by.

- MeetingTone: one or two blocks describing the emotional register and how it moved -- e.g. "Collaborative throughout; brief tension when the timeline slipped, resolved by rescoping" or "Efficient and transactional; no disagreement surfaced". Note significant shifts. This is the one section where subjective reading is expected; everywhere else stay objective.

- SectionSummary: 4-8 bullets on the substance of the discussion. Each is one concrete idea with enough specificity to be useful months later -- name the systems, numbers, customers, and tradeoffs actually discussed. Prefer "Warehouse API returns stale inventory when two orders hit within 200ms" over "discussed a technical issue". Capture disagreements and the reasoning behind them, not just conclusions.

- KeyItemsDecisions: decisions actually made, not options merely considered. Lead with the verb and attribute where clear: "Decided to ... (Sarah, with Ops agreeing)", "Agreed that ...". Where a decision has an immediate consequence, state it in the same bullet.

- ImmediateActionItems: every committed task. Format each block EXACTLY as:
    <Owner> | <specific action> | <due date>
  Use " | " as the separator so the app can render these as a table. Owner is a person's name, or "Unassigned" if nobody took it. Due date is a real date when stated, otherwise a stated relative deadline ("end of week"), otherwise "TBD". Never drop the separators, and never omit a task because its owner or date is missing -- write "Unassigned" or "TBD" instead.

- OpenQuestions: questions raised but not answered, and decisions explicitly deferred. Format "<the open question> -- <who needs to resolve it, if stated>". This section is how the next meeting gets its agenda; be thorough.

- ProblemsSolutions: problems or blockers named in the meeting, each paired with what was proposed about it. Format "PROBLEM: <the problem> -> PROPOSED: <the approach discussed, or 'no solution proposed'>". One block per problem. Include problems raised even if nobody offered a fix -- an unaddressed problem is the most valuable thing this section can surface.

- CriticalDeadlines: hard dates and deadlines explicitly stated. Format "Ship by Fri 2026-05-15 -- <what>". Only genuine deadlines, not general future intentions.

- NextSteps: follow-ups and scheduled activity that are not owned tasks, e.g. "Team reconvenes Thursday to review the vendor quote".

- OtherImportantPoints: substantive context that fits nowhere above -- risks, dependencies, budget figures, customer names, competitive intel, anything a reader would want on the record.

- ClosingRemarks: only if the transcript genuinely contains a wrap-up. Do not invent one.

Rules:
- Be specific and concrete. Name names, numbers, dates, and systems. Vague bullets are the main failure mode; a reader who missed the meeting should not have to open the transcript.
- Be comprehensive on substance, economical in wording. Each bullet stands alone and earns its place.
- Ground everything in the transcript. Never invent an owner, date, decision, or participant. If something was ambiguous, reflect the ambiguity.
- Do NOT pad. If a section has no support, return blocks: []. Empty is correct, not a failure. The ONE exception is BottomLine, which is always required -- it is synthesized from the meeting as a whole, so there is always something to write.
- Do NOT repeat the same point across sections.
- Skip greetings, filler, scheduling chatter, and off-topic tangents.
- Plain text inside blocks. No markdown, no HTML, no bullet characters -- the app supplies its own formatting.
- Output ONLY the JSON -- no preamble, no commentary.

Return a JSON OBJECT (not an array) whose keys are exactly the section names above. MeetingName is a plain string. Every other key maps to:
  {{ "title": "<human-readable section title>", "blocks": [ {{ "id": "<unique-id>", "type": "bullet", "content": "<text>", "color": "default" }}, ... ] }}

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
    async def process_transcript(
        self,
        text: str,
        model: str,
        model_name: str,
        chunk_size: int = 5000,
        overlap: int = 1000,
        custom_prompt: Optional[str] = None,
        meeting_id: Optional[str] = None,
    ) -> Tuple[int, List[str]]:
        """
        Process transcript text into chunks and generate structured summaries for each chunk using an AI model.

        Args:
            text: The transcript text.
            model: The AI model provider ('gemini', 'claude', 'groq', 'openai').
            model_name: The specific model name.
            chunk_size: The size of each text chunk.
            overlap: The overlap between consecutive chunks.
            custom_prompt: Phase 4 Task 1B per-meeting one-off
                instruction. When non-empty, appended to the standard
                template AFTER the schema/rules block but BEFORE the
                transcript text, so it shapes content focus without
                breaking the JSON output shape.

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
                # Phase 4 Task 1A: env var wins over the DB-stored key.
                # Phase 8 Task 2: bundled BUNDLED_GEMINI_KEY is the
                # third-priority fallback for packaged MSI installs
                # where the user never enters a key.
                api_key = (
                    os.environ.get("GEMINI_API_KEY")
                    or await db.get_api_key("gemini")
                )
                if not api_key:
                    try:
                        from keys import BUNDLED_GEMINI_KEY  # noqa: E402
                        if BUNDLED_GEMINI_KEY:
                            api_key = BUNDLED_GEMINI_KEY
                    except Exception:
                        pass
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
                # Phase 4 Task 1B: optional per-meeting addendum.
                # We splice it into the template by replacing the chunk
                # marker so the addendum lands BEFORE the transcript
                # text — keeping the schema/rules block authoritative.
                if custom_prompt and custom_prompt.strip():
                    addendum = (
                        "\n\nAdditional instructions for this meeting "
                        "(user-provided — apply on top of the rules above):\n"
                        f"{custom_prompt.strip()}\n"
                    )
                    prompt = _SUMMARY_PROMPT_TEMPLATE.format(
                        chunk=chunk
                    ).replace("Transcript Chunk:", f"{addendum}Transcript Chunk:")
                else:
                    prompt = _SUMMARY_PROMPT_TEMPLATE.format(chunk=chunk)
                try:
                    if model == "gemini":
                        # Direct google-genai call. response_schema=SummaryResponse
                        # tells Gemini to emit JSON conforming to that pydantic
                        # class — equivalent to pydantic-ai's result_type wiring
                        # but native to the SDK. response.text is the raw JSON
                        # string, which is exactly the shape we already store.
                        #
                        # Phase 5 Task 1: wrapped in @with_retry so transient
                        # Gemini 503 ServerErrors auto-retry up to 3 times
                        # (exponential backoff 2s/4s) before bubbling up.
                        # Most US-business-hours overload blips become
                        # invisible to the user.
                        @with_retry
                        async def _generate_chunk():
                            return await gemini_client.aio.models.generate_content(
                                model=model_name,
                                contents=prompt,
                                config=genai_types.GenerateContentConfig(
                                    # Lower temperature → more consistent
                                    # structured output. The summarisation
                                    # task does not benefit from creativity.
                                    temperature=0.3,
                                    response_mime_type="application/json",
                                    response_schema=SummaryResponse,
                                ),
                            )
                        response = await _generate_chunk()
                        chunk_summary_json = response.text
                        # Validate it parses; surface a useful error if Gemini
                        # ever ignores the schema (shouldn't happen with
                        # response_schema set, but cheap insurance).
                        json.loads(chunk_summary_json)
                        all_json_data.append(chunk_summary_json)
                        logger.info(f"Successfully generated summary for chunk {i+1} via Gemini.")
                        # Phase 8 Task 1: cost log for this chunk.
                        try:
                            import costs as _costs  # noqa: E402
                            in_tok, out_tok = _costs.extract_usage_from_response(response)
                            await _costs.record_usage(
                                self.db.db_path,
                                _costs.Usage(
                                    endpoint="summary",
                                    model=model_name,
                                    input_tokens=in_tok,
                                    output_tokens=out_tok,
                                    meeting_id=meeting_id,
                                    notes=f"chunk {i+1}/{num_chunks}",
                                ),
                            )
                        except Exception as cost_err:
                            logger.warning(
                                "summary chunk %d cost log failed: %s",
                                i + 1, cost_err,
                            )
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
                # Phase 5 Task 1: surface a HUMAN-READABLE error rather
                # than re-raising the same exception type. The previous
                # `raise type(last_chunk_error)(...)` invoked the original
                # exception's constructor with one arg, but Gemini SDK
                # errors require multiple positional args (status_code,
                # response_json, response_obj). The user saw
                # "APIError.__init__() missing 1 required positional
                # argument" instead of "Gemini is overloaded, try again".
                #
                # RuntimeError(...) from <orig> preserves the traceback
                # via __cause__ for debugging, while letting us write a
                # clear top-line message tailored to each error class.
                if isinstance(last_chunk_error, gemini_errors.ServerError):
                    status = (
                        getattr(last_chunk_error, "code", None)
                        or getattr(last_chunk_error, "status_code", None)
                        or "5xx"
                    )
                    raise RuntimeError(
                        f"Gemini is temporarily unavailable (HTTP {status}). "
                        "This is usually a brief overload — please try again "
                        "in a moment."
                    ) from last_chunk_error
                if isinstance(last_chunk_error, gemini_errors.ClientError):
                    raise RuntimeError(
                        f"Gemini rejected the request: {last_chunk_error}"
                    ) from last_chunk_error
                if isinstance(last_chunk_error, gemini_errors.APIError):
                    raise RuntimeError(
                        f"Gemini error: {last_chunk_error}"
                    ) from last_chunk_error
                raise RuntimeError(
                    f"Summary generation failed after {num_chunks} chunk(s): "
                    f"{last_chunk_error}"
                ) from last_chunk_error
            return num_chunks, all_json_data

        except Exception as e:
            logger.error(f"Error during transcript processing: {str(e)}", exc_info=True)
            raise