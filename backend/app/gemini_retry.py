"""Phase 5 Task 1: tenacity retry helper for Gemini calls.

Wraps `client.aio.models.generate_content` (and similar) so transient
HTTP 5xx responses from Gemini auto-retry up to 3 times with
exponential backoff before bubbling up. ClientError (4xx — quota,
auth, bad request) is NOT retried because those are deterministic
failures.

Usage::

    from app.gemini_retry import with_retry

    @with_retry
    async def _do_call():
        return await client.aio.models.generate_content(...)

    response = await _do_call()

Tenacity is already a transitive dep of google-genai, so no new
package needs adding.
"""

import logging

import google.genai.errors as gemini_errors
from tenacity import (
    AsyncRetrying,
    before_sleep_log,
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

logger = logging.getLogger(__name__)

# Tunables — fixed for v1, no Settings exposure (per Task 1 out-of-scope).
_RETRY_ATTEMPTS = 3                  # initial + 2 retries
_RETRY_WAIT_MIN_SECONDS = 2          # first backoff
_RETRY_WAIT_MAX_SECONDS = 10         # cap


def with_retry(func):
    """Decorator: retry an async fn up to 3 times on Gemini ServerError.

    The retry policy:
      - 3 total attempts (initial + 2 retries)
      - Exponential backoff capped at 10s (effectively 2s, 4s)
      - Retries ONLY on `ServerError` — never on `ClientError` (4xx
        responses are deterministic, retrying won't help)
      - `reraise=True` so the final failure surfaces with the
        original exception type intact
      - Logs each retry attempt at WARNING so a spike of 503s is
        visible in the backend log without spamming on every chunk

    Applied to /process-transcript chunk calls, /transcribe-audio,
    /saved-prompts/enhance, and the meeting-name path (which goes
    through the summary call).
    """
    return retry(
        stop=stop_after_attempt(_RETRY_ATTEMPTS),
        wait=wait_exponential(
            multiplier=1,
            min=_RETRY_WAIT_MIN_SECONDS,
            max=_RETRY_WAIT_MAX_SECONDS,
        ),
        retry=retry_if_exception_type(gemini_errors.ServerError),
        reraise=True,
        before_sleep=before_sleep_log(logger, logging.WARNING),
    )(func)


__all__ = ["with_retry"]
