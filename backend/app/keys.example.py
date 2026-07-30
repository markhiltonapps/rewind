"""Template for backend/app/keys.py.

`keys.py` is .gitignored — populated locally before running
`build_sidecar.py` and never committed. Copy this file to `keys.py`
to bootstrap a fresh clone:

    cp backend/app/keys.example.py backend/app/keys.py

Then edit `keys.py` with your real key. Without `keys.py` the
backend still imports — the bundled-key fallback is guarded by
try/except and simply skipped.

Key resolution priority (see main.py:_resolve_gemini_api_key):
  1. GEMINI_API_KEY env var
  2. settings.geminiApiKey in DB
  3. BUNDLED_GEMINI_KEY (this slot)
  4. None → 503 from Gemini-facing endpoints
"""

BUNDLED_GEMINI_KEY = ""
