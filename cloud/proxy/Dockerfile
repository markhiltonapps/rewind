FROM python:3.12-slim

WORKDIR /app

# ffmpeg + ffprobe: used by app/audio_chunk.py to split long recordings
# into pieces that each transcribe well within the request timeout.
# Without it the service still works -- transcribe() falls back to a
# single call -- but long meetings can time out again.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code only (tests / venv excluded via .dockerignore).
COPY app ./app

# Cloud Run provides $PORT (default 8080). Bind uvicorn to it.
ENV PORT=8080
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
