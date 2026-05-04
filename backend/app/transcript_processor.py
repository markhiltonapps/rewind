from pydantic import BaseModel
from typing import List, Tuple
from pydantic_ai import Agent
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.models.groq import GroqModel
from pydantic_ai.models.openai import OpenAIModel
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
            model: The AI model provider ('claude', 'ollama', 'groq', 'openai').
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
        agent = None # Define agent variable
        llm = None # Define llm variable

        try:
            # Select and initialize the AI model and agent
            if model == "claude":
                api_key = await db.get_api_key("claude")
                if not api_key: raise ValueError("ANTHROPIC_API_KEY environment variable not set")
                llm = AnthropicModel(model_name, api_key=api_key)
                logger.info(f"Using Claude model: {model_name}")
            elif model == "ollama":
                # Assumes Ollama server is running locally at default address
                # You might need host/port configuration if it's elsewhere
                llm = OllamaModel(model_name)
                logger.info(f"Using Ollama model: {model_name}")
            elif model == "groq":
                api_key = await db.get_api_key("groq")
                if not api_key: raise ValueError("GROQ_API_KEY environment variable not set")
                llm = GroqModel(model_name, api_key=api_key)
                logger.info(f"Using Groq model: {model_name}")
            # --- ADD OPENAI SUPPORT HERE ---
            elif model == "openai":
                api_key = await db.get_api_key("openai")
                if not api_key: raise ValueError("OPENAI_API_KEY environment variable not set")
                llm = OpenAIModel(model_name, api_key=api_key)
                logger.info(f"Using OpenAI model: {model_name}")
            # --- END OPENAI SUPPORT ---
            else:
                logger.error(f"Unsupported model provider requested: {model}")
                raise ValueError(f"Unsupported model provider: {model}")

            # Initialize the agent with the selected LLM
            agent = Agent(
                llm,
                result_type=SummaryResponse,
                result_retries=5,
            )
            logger.info("Pydantic-AI Agent initialized.")

            # Split transcript into chunks
            step = chunk_size - overlap
            if step <= 0:
                logger.warning(f"Overlap ({overlap}) >= chunk_size ({chunk_size}). Adjusting overlap.")
                overlap = max(0, chunk_size - 100)
                step = chunk_size - overlap

            chunks = [text[i:i+chunk_size] for i in range(0, len(text), step)]
            num_chunks = len(chunks)
            logger.info(f"Split transcript into {num_chunks} chunks.")

            for i, chunk in enumerate(chunks):
                logger.info(f"Processing chunk {i+1}/{num_chunks}...")
                try:
                    # Run the agent to get the structured summary for the chunk
                    summary_result = await agent.run(
                        f"""You are summarizing a chunk of a meeting transcript into the required JSON structure.

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

Transcript Chunk:
---
{chunk}
---
""",
                    )

                    if hasattr(summary_result, 'data') and isinstance(summary_result.data, SummaryResponse):
                         final_summary_pydantic = summary_result.data
                    elif isinstance(summary_result, SummaryResponse):
                         final_summary_pydantic = summary_result
                    else:
                         logger.error(f"Unexpected result type from agent for chunk {i+1}: {type(summary_result)}")
                         continue # Skip this chunk

                    # Convert the Pydantic model to a JSON string
                    chunk_summary_json = final_summary_pydantic.model_dump_json()
                    all_json_data.append(chunk_summary_json)
                    logger.info(f"Successfully generated summary for chunk {i+1}.")

                except Exception as chunk_error:
                    logger.error(f"Error processing chunk {i+1}: {chunk_error}", exc_info=True)

            logger.info(f"Finished processing all {num_chunks} chunks.")
            return num_chunks, all_json_data

        except Exception as e:
            logger.error(f"Error during transcript processing: {str(e)}", exc_info=True)
            raise