<div align="center">
  <h1>Neato Rewind</h1>
  <p><strong>Privacy-first meeting and video rewind for Windows.</strong></p>
  <p>A commercial product of Neato Ventures LLC (Houston, TX).</p>
</div>

---

## Overview

Neato Rewind records, transcribes, and summarizes meetings and videos in
the background. Audio capture, transcription (Whisper.cpp), and AI
summarization all run locally on your machine — your meeting content
never leaves your computer unless you point a summarizer at a hosted
LLM provider.

This is a Windows desktop application. macOS scripts and packaging from
the upstream Meetily project are present in the tree but are not
currently maintained or supported by Neato Ventures.

## Architecture

Neato Rewind runs as three local processes:

1. **Frontend** (`frontend/`) — Tauri 2 + Next.js desktop app
2. **Python backend** (`backend/`) — FastAPI on `localhost:5167`
3. **Whisper server** (`backend/whisper-server-package/whisper-server.exe`) —
   native C++ binary built from `backend/whisper.cpp/`, runs on
   `localhost:8178`

The frontend talks to the Python backend over HTTP. The Python backend
talks to the Whisper server over HTTP.

## Prerequisites

- Windows 10 or later
- Node.js 18+
- Python 3.10+
- Rust (latest stable)
- pnpm 8+
- Visual Studio Build Tools with the C++ workload
- CMake 3.22+
- FFmpeg on `PATH`
- Ollama (for local LLM inference) — optional if using Anthropic or Groq

## Setup

### Backend

```cmd
cd backend
build_whisper.cmd
start_with_output.ps1
```

`build_whisper.cmd` initializes the `whisper.cpp` submodule, compiles
the Whisper server with custom modifications, and prepares
`whisper-server-package/`. `start_with_output.ps1` prompts for a
Whisper model and starts both the Whisper server (port 8178) and the
FastAPI backend (port 5167) in separate windows.

### Frontend

```cmd
cd frontend
pnpm install
pnpm tauri dev
```

To build a release bundle:

```cmd
pnpm tauri build
```

## Configuration

LLM provider keys are read from `backend/.env`:

```env
ANTHROPIC_API_KEY=...   # optional, for Claude
GROQ_API_KEY=...        # optional, for Groq
```

Ollama is the default local provider and requires no API key.

## License

Neato Rewind is a commercial product of Neato Ventures LLC. All Neato
modifications, additions, and the Neato Rewind product as a whole are
governed by [`LICENSE-NEATO.md`](LICENSE-NEATO.md).

### Built on Meetily (MIT)

Neato Rewind is built on [Meetily](https://github.com/Zackriya-Solutions/meeting-minutes)
by Zackriya Solutions, used under the MIT License. The original Meetily
copyright and license notice is preserved in [`LICENSE.md`](LICENSE.md)
as required by MIT.

See [`CREDITS.md`](CREDITS.md) for the full list of open-source
dependencies that make Neato Rewind possible.
