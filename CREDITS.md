# Built on open source

Neato Rewind would not exist without the open-source projects below.
This file lists major dependencies and the upstream codebase Neato Rewind
is built on. Transitive dependencies are not enumerated; consult the
respective lockfiles (`frontend/src-tauri/Cargo.lock`,
`frontend/package.json`, `backend/requirements.txt`) for the full graph.

## Upstream

- **[Meetily](https://github.com/Zackriya-Solutions/meeting-minutes)** by
  Zackriya Solutions — MIT License. Neato Rewind forks Meetily at tag
  `v0.0.4` and inherits its three-process architecture
  (Tauri/Next.js frontend, FastAPI Python backend, native Whisper server).
  See [`LICENSE.md`](LICENSE.md) for the preserved Meetily copyright notice.

## Transcription

- **[Whisper.cpp](https://github.com/ggerganov/whisper.cpp)** by Georgi Gerganov — MIT License.
  Local C++ inference for OpenAI's Whisper models. Vendored as a git
  submodule under `backend/whisper.cpp/` (Zackriya fork, develop branch).
- **[ggml](https://github.com/ggerganov/ggml)** by Georgi Gerganov — MIT License.
  Tensor library underlying Whisper.cpp.

## Frontend (Tauri + Next.js)

- **[Tauri](https://tauri.app/)** — MIT / Apache-2.0. Desktop runtime.
- **[Next.js](https://nextjs.org/)** — MIT License. React framework.
- **[React](https://react.dev/)** — MIT License.
- **[Tailwind CSS](https://tailwindcss.com/)** — MIT License.
- **[Remirror](https://remirror.io/)** and **[TipTap](https://tiptap.dev/)** — MIT License. Rich text editors.
- **[Heroicons](https://heroicons.com/)** and **[Lucide](https://lucide.dev/)** — MIT / ISC. Icon sets.
- **[Framer Motion](https://www.framer.com/motion/)** — MIT License.
- **[react-markdown](https://github.com/remarkjs/react-markdown)** — MIT License.
- **[lodash](https://lodash.com/)** — MIT License.

## Frontend (Rust / Tauri side)

- **[cpal](https://github.com/RustAudio/cpal)** — Apache-2.0. Cross-platform
  audio capture (fork: `Kree0/cpal`).
- **[symphonia](https://github.com/pdeljanov/Symphonia)** — MPL-2.0. Audio
  demuxing and decoding.
- **[hound](https://github.com/ruuda/hound)** — Apache-2.0. WAV encoding.
- **[realfft](https://github.com/HEnquist/realfft)** — MIT License.
- **[ndarray](https://github.com/rust-ndarray/ndarray)** — MIT / Apache-2.0.
- **[rubato](https://github.com/HEnquist/rubato)** — MIT License. Audio
  resampling.
- **[tokio](https://tokio.rs/)**, **[reqwest](https://github.com/seanmonstar/reqwest)**,
  **[serde](https://serde.rs/)**, **[anyhow](https://github.com/dtolnay/anyhow)**,
  **[crossbeam](https://github.com/crossbeam-rs/crossbeam)**,
  **[dashmap](https://github.com/xacrimon/dashmap)** — all MIT or Apache-2.0.
- **[ffmpeg-sidecar](https://github.com/nathanbabcock/ffmpeg-sidecar)** —
  MIT License. Wraps the FFmpeg binary.
- **[FFmpeg](https://ffmpeg.org/)** — LGPL-2.1+ / GPL-2.1+ depending on
  build configuration. Used as an external sidecar binary.

## Backend (Python)

- **[FastAPI](https://fastapi.tiangolo.com/)** — MIT License.
- **[Uvicorn](https://www.uvicorn.org/)** — BSD-3-Clause.
- **[Pydantic](https://docs.pydantic.dev/)** and
  **[pydantic-ai](https://ai.pydantic.dev/)** — MIT License.
- **[aiosqlite](https://github.com/omnilib/aiosqlite)** — MIT License.
- **[python-multipart](https://github.com/Kludex/python-multipart)** — Apache-2.0.
- **[python-dotenv](https://github.com/theskumar/python-dotenv)** — BSD-3-Clause.
- **[pandas](https://pandas.pydata.org/)** — BSD-3-Clause.
- **[devtools](https://github.com/samuelcolvin/python-devtools)** — MIT License.

## LLM providers (optional, runtime services)

- **[Ollama](https://ollama.com/)** — MIT License. Local LLM runtime.
- **Anthropic Claude API** — proprietary cloud service (optional).
- **Groq API** — proprietary cloud service (optional).

---

If you believe a project is missing from this list or attributed
incorrectly, please contact Neato Ventures LLC.
