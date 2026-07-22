use std::fs;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::Duration;
use serde::{Deserialize, Serialize};

// Declare audio module
pub mod audio;

// Phase 2a: detection + state machine + rolling buffer
pub mod detector;
pub mod state_machine;
pub mod rolling_buffer;
pub mod tray;

use audio::{
    default_input_device, default_output_device, AudioStream,
};
use tauri::{Runtime, AppHandle, Emitter, Manager};
use log::{info as log_info, error as log_error, debug as log_debug};
use reqwest::multipart::{Form, Part};

use detector::DetectionSource;
use rolling_buffer::RollingBuffer;
use state_machine::{
    ControlEvent, RecorderAction, RecorderState, SharedStateMachine, StateMachine,
};
use tokio::sync::{mpsc, Notify};

/// Phase 2b round 2: synchronization point so `stop_recording` can wait for
/// the transcription task's post-loop flush to complete before tearing down
/// streams and the action handler emits `recording-saving`. A fresh `Notify`
/// is installed by every `start_recording` call; the spawned task captures
/// a clone and calls `notify_one()` once its final partial chunk has been
/// sent to whisper-server (or after a network error). `stop_recording`
/// reads the same slot and awaits `notified()` with a 10s timeout.
struct FlushSignal {
    inner: tokio::sync::Mutex<Option<Arc<Notify>>>,
}

impl Default for FlushSignal {
    fn default() -> Self {
        Self {
            inner: tokio::sync::Mutex::new(None),
        }
    }
}

/// Phase 2b round 4: a single source of truth for the active recording
/// session. Rust now owns:
///
///   * the meeting id (generated at StartRecording time)
///   * the meeting title
///   * the detection source + confidence
///   * the started_at timestamp
///   * the live transcript buffer
///
/// The frontend used to hold the transcript buffer and POST
/// `/save-transcript` itself. That meant a page refresh during recording
/// (or any React-state wipe) lost the buffer and the meeting was never
/// persisted. With Rust authoritative, the frontend can be reloaded
/// freely — Rust still has every transcript and POSTs them itself when
/// the FSM finishes draining.
///
/// `Option<RecordingSession>` because Idle has no session.
#[derive(Debug, Clone)]
struct RecordingSession {
    meeting_id: String,
    title: String,
    detection_source: String,
    detection_confidence: String,
    is_manual: bool,
    started_at: String, // ISO 8601 UTC
    transcripts: Vec<TranscriptUpdate>,
    /// Phase 4 Task 1C: full-recording WAV bytes captured by
    /// stop_recording. save_session_to_backend uploads this to the
    /// Python backend's /transcribe-audio endpoint (which forwards to
    /// Gemini), then pushes the returned transcript into the
    /// `transcripts` vec before posting /save-transcript. None when
    /// the recording captured no audio at all.
    pending_audio_wav: Option<Vec<u8>>,
}

#[derive(Default)]
struct SessionState {
    inner: tokio::sync::Mutex<Option<RecordingSession>>,
}

/// Snapshot of recording state, exported via the `get_recording_state`
/// Tauri command for UI mount-time reconciliation. Optional fields are
/// `None` while the FSM is Idle.
#[derive(Debug, Serialize, Clone)]
struct RecordingStateSnapshot {
    state: String,
    meeting_id: Option<String>,
    title: Option<String>,
    detection_source: Option<String>,
    detection_confidence: Option<String>,
    started_at: Option<String>,
    is_manual: Option<bool>,
}

static RECORDING_FLAG: AtomicBool = AtomicBool::new(false);

// Auth token holder: set by the frontend after login via set_auth_token command.
// OnceLock is stdlib-only (no new deps). The inner Mutex<Option<String>> lets
// us update the token at runtime without unsafe.
static AUTH_TOKEN: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();

fn auth_token_lock() -> &'static std::sync::Mutex<Option<String>> {
    AUTH_TOKEN.get_or_init(|| std::sync::Mutex::new(None))
}

fn store_auth_token(t: Option<String>) {
    if let Ok(mut guard) = auth_token_lock().lock() {
        *guard = t;
    }
}

fn current_auth_token() -> Option<String> {
    auth_token_lock().lock().ok()?.clone()
}
static mut MIC_BUFFER: Option<Arc<Mutex<Vec<f32>>>> = None;
static mut SYSTEM_BUFFER: Option<Arc<Mutex<Vec<f32>>>> = None;
// Phase 6 Task 4 (Option 1): when set, the next manual recording
// will discard the mic buffer at mix time and emit a system-audio-
// only WAV. Used for capturing browser content (Loom, Vimeo, podcast
// web players) where the user is listening, not narrating, and any
// incidental mic noise would corrupt the transcription. Cleared by
// stop_recording so it doesn't leak into a subsequent meeting
// recording. Atomic so the mix call site can read it without a lock.
static SYSTEM_AUDIO_ONLY: AtomicBool = AtomicBool::new(false);
static mut MIC_STREAM: Option<Arc<AudioStream>> = None;
static mut SYSTEM_STREAM: Option<Arc<AudioStream>> = None;
static mut IS_RUNNING: Option<Arc<AtomicBool>> = None;
static mut RECORDING_START_TIME: Option<std::time::Instant> = None;

// Audio configuration constants
// Phase 4 Task 1C: Whisper is gone. Audio is buffered for the full
// recording, then sent ONCE to the Python backend at end-of-recording,
// which forwards to Gemini's audio API. The previous per-chunk send-
// to-localhost-8178 path with TranscriptAccumulator / TranscriptSegment
// / WHISPER_* constants / resample_audio() / send_audio_chunk() is all
// removed.
const MIN_RECORDING_DURATION_MS: u64 = 2000; // 2 seconds minimum

#[derive(Debug, Deserialize)]
struct RecordingArgs {
    save_path: String,
}

#[derive(Debug, Serialize, Clone)]
struct TranscriptUpdate {
    text: String,
    timestamp: String,
    source: String,
}

/// Mix mic + system buffers into mono and encode as 16-bit PCM WAV
/// bytes. Used by stop_recording to package the full session audio for
/// Gemini transcription. The 70/30 mic-weighted mix matches what the
/// removed live-Whisper pipeline used so far-end audio doesn't drown
/// out the local speaker.
///
/// Phase 6 Task 4 (Option 1): when SYSTEM_AUDIO_ONLY is set the mic
/// buffer is discarded and the system buffer is emitted at full
/// amplitude (no 30% attenuation). This is for browser-content
/// recording where the user is listening, not narrating — any
/// incidental mic noise would corrupt the transcription.
///
/// Phase 8 Task 12: the previous single-rate path assumed mic and
/// system buffers shared a sample rate. They almost never do on
/// Windows — mic is often 16 or 44.1 kHz, WASAPI loopback is 48 kHz.
/// Mixing sample-by-sample under that assumption produced WAVs where
/// the system audio played at the WRONG rate (slow-motion, low pitch).
/// We now take both rates separately, resample each to a common
/// 16 kHz target (Gemini's preferred input rate — also cuts the WAV
/// size 3× vs 48 kHz), then run the existing mix loop. Resample
/// failures are logged and fall back to using the raw buffer at the
/// target rate (degraded but not silent — better than failing the
/// whole save).
fn mix_to_mono_wav_bytes(
    mic: &[f32],
    system: &[f32],
    mic_sample_rate: u32,
    system_sample_rate: u32,
) -> Result<Vec<u8>, String> {
    use std::io::Cursor;

    // Phase 8 Task 12: 16 kHz is Gemini's preferred speech rate. Any
    // higher (48 kHz default loopback) costs us 3× the audio tokens
    // and yields no transcription quality gain because speech energy
    // is concentrated under 8 kHz anyway.
    const TARGET_SAMPLE_RATE: u32 = 16_000;

    let resample_to_target = |buf: &[f32], from: u32, name: &str| -> Vec<f32> {
        if buf.is_empty() || from == TARGET_SAMPLE_RATE {
            return buf.to_vec();
        }
        match crate::audio::audio_processing::resample(buf, from, TARGET_SAMPLE_RATE) {
            Ok(out) => out,
            Err(e) => {
                log_error!(
                    "mix_to_mono_wav_bytes: {} resample {} → {} failed: {} — \
                     falling back to raw buffer (audio will be at wrong rate)",
                    name, from, TARGET_SAMPLE_RATE, e
                );
                buf.to_vec()
            }
        }
    };

    let mic_rs = resample_to_target(mic, mic_sample_rate, "mic");
    let system_rs = resample_to_target(system, system_sample_rate, "system");
    log_info!(
        "mix_to_mono_wav_bytes: resampled mic {}→{} samples, system {}→{} samples at {} Hz",
        mic.len(), mic_rs.len(),
        system.len(), system_rs.len(),
        TARGET_SAMPLE_RATE
    );

    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let system_only = SYSTEM_AUDIO_ONLY.load(Ordering::SeqCst);
    let mut buf: Vec<u8> = Vec::with_capacity(44 + mic_rs.len().max(system_rs.len()) * 2);
    {
        let cursor = Cursor::new(&mut buf);
        let mut writer = hound::WavWriter::new(cursor, spec)
            .map_err(|e| format!("WavWriter::new failed: {e}"))?;

        if system_only {
            // System-only path: emit system samples directly with
            // full amplitude. No mic mix-in.
            for &s in &system_rs {
                let sample_i16 = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                writer
                    .write_sample(sample_i16)
                    .map_err(|e| format!("WavWriter::write_sample failed: {e}"))?;
            }
        } else {
            // Standard 70/30 mic-weighted mix. Both buffers are now
            // at the same sample rate so sample-by-sample mixing is
            // temporally aligned.
            let len = mic_rs.len().max(system_rs.len());
            for i in 0..len {
                let m = mic_rs.get(i).copied().unwrap_or(0.0);
                let s = system_rs.get(i).copied().unwrap_or(0.0);
                let mixed = ((m * 0.7) + (s * 0.3)).clamp(-1.0, 1.0);
                let sample_i16 = (mixed * i16::MAX as f32) as i16;
                writer
                    .write_sample(sample_i16)
                    .map_err(|e| format!("WavWriter::write_sample failed: {e}"))?;
            }
        }
        writer
            .finalize()
            .map_err(|e| format!("WavWriter::finalize failed: {e}"))?;
    }
    Ok(buf)
}

/// Parse a canonical 16-bit PCM WAV header and return its duration in
/// seconds. Returns 0.0 if the header isn't a readable RIFF/WAV.
fn wav_duration_secs(wav: &[u8]) -> f64 {
    if wav.len() < 44 || &wav[0..4] != b"RIFF" {
        return 0.0;
    }
    let channels = u16::from_le_bytes([wav[22], wav[23]]) as f64;
    let rate = u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]) as f64;
    let data_sz = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as f64;
    if channels <= 0.0 || rate <= 0.0 {
        return 0.0;
    }
    data_sz / (rate * channels * 2.0)
}

/// Compress a WAV blob to Ogg/Opus using the bundled ffmpeg. Uncompressed
/// WAV is ~1.9 MB/min, so a meeting past ~17 min exceeds Cloud Run's 32 MB
/// request cap and the proxy 413s. Opus keeps even multi-hour meetings tiny.
/// Returns the Opus bytes, or an error if ffmpeg is unavailable/fails (the
/// caller then falls back to sending the raw WAV).
fn compress_wav_to_opus(wav: &[u8]) -> Result<Vec<u8>, String> {
    let ffmpeg = crate::audio::ffmpeg::find_ffmpeg_path()
        .ok_or_else(|| "ffmpeg not available".to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir();
    let in_path = dir.join(format!("rw_tx_{nanos}.wav"));
    let out_path = dir.join(format!("rw_tx_{nanos}.ogg"));
    std::fs::write(&in_path, wav).map_err(|e| format!("write temp wav: {e}"))?;
    let run = (|| -> Result<Vec<u8>, String> {
        let output = std::process::Command::new(&ffmpeg)
            .arg("-y")
            .arg("-i")
            .arg(&in_path)
            .args(["-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "16k", "-f", "ogg"])
            .arg(&out_path)
            .output()
            .map_err(|e| format!("ffmpeg spawn: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "ffmpeg exit {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        std::fs::read(&out_path).map_err(|e| format!("read opus: {e}"))
    })();
    let _ = std::fs::remove_file(&in_path);
    let _ = std::fs::remove_file(&out_path);
    run
}

/// Phase 4 Task 1C: POST a recorded WAV blob to the Python backend's
/// /transcribe-audio endpoint, which forwards it to Gemini's audio API
/// and returns the full transcript text. The audio is compressed to
/// Ogg/Opus first so long meetings stay under the proxy's 32 MB cap.
async fn transcribe_via_backend(wav_bytes: Vec<u8>) -> Result<String, String> {
    #[derive(Deserialize)]
    struct TranscribeResponse {
        transcript: String,
    }

    // Duration for server-side metering — read from the WAV before we
    // compress, since the compressed stream isn't a parseable WAV.
    let duration_secs = wav_duration_secs(&wav_bytes);
    let wav_len = wav_bytes.len();

    let (audio_bytes, mime, fname) = match compress_wav_to_opus(&wav_bytes) {
        Ok(opus) => {
            log::info!(
                "[transcribe] compressed WAV {} KB -> Opus {} KB",
                wav_len / 1024,
                opus.len() / 1024
            );
            (opus, "audio/ogg", "recording.ogg")
        }
        Err(e) => {
            log::warn!("[transcribe] Opus compression failed ({e}); sending raw WAV");
            (wav_bytes, "audio/wav", "recording.wav")
        }
    };

    let part = Part::bytes(audio_bytes)
        .file_name(fname)
        .mime_str(mime)
        .map_err(|e| format!("multipart Part: {e}"))?;
    let form = Form::new().part("file", part);

    // Gemini transcription of a 30-min recording can take 30-60s on
    // a happy path, but a long meeting layered with Gemini overload
    // (Phase 5 Task 1's auto-retry adds up to ~16s per chunk on 503,
    // and chunked transcription multiplies that across N chunks)
    // routinely blows past 180s. 600s gives enough headroom for a
    // long meeting + a Gemini hiccup or two without hanging forever
    // — when this fires, the Phase 5 Task 1 recovery WAV is already
    // safely on disk and the toast points the user at the recovery
    // script.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("reqwest::Client::build: {e}"))?;

    let mut req = client
        .post("http://127.0.0.1:5167/transcribe-audio")
        .header("x-audio-duration", format!("{duration_secs}"))
        .multipart(form);
    if let Some(tok) = current_auth_token() {
        req = req.header("Authorization", format!("Bearer {}", tok));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("/transcribe-audio request: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp
            .text()
            .await
            .unwrap_or_else(|_| "<no body>".into());
        return Err(format!("/transcribe-audio HTTP {}: {}", status, body));
    }

    let parsed = resp
        .json::<TranscribeResponse>()
        .await
        .map_err(|e| format!("/transcribe-audio body parse: {e}"))?;
    Ok(parsed.transcript)
}



#[tauri::command]
async fn start_recording<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    log_info!("Attempting to start recording...");
    
    if is_recording() {
        log_error!("Recording already in progress");
        return Err("Recording already in progress".to_string());
    }

    // Initialize recording flag and buffers
    RECORDING_FLAG.store(true, Ordering::SeqCst);
    log_info!("Recording flag set to true");

    // Store recording start time
    unsafe {
        RECORDING_START_TIME = Some(std::time::Instant::now());
    }

    // Initialize audio buffers
    unsafe {
        MIC_BUFFER = Some(Arc::new(Mutex::new(Vec::new())));
        SYSTEM_BUFFER = Some(Arc::new(Mutex::new(Vec::new())));
        log_info!("Initialized audio buffers");
    }
    
    // Get default devices
    let mic_device = Arc::new(default_input_device().map_err(|e| {
        log_error!("Failed to get default input device: {}", e);
        e.to_string()
    })?);
    
    let system_device = Arc::new(default_output_device().map_err(|e| {
        log_error!("Failed to get default output device: {}", e);
        e.to_string()
    })?);
    
    // Create audio streams
    let is_running = Arc::new(AtomicBool::new(true));
    
    // Create microphone stream
    let mic_stream = AudioStream::from_device(mic_device.clone(), is_running.clone())
        .await
        .map_err(|e| {
            log_error!("Failed to create microphone stream: {}", e);
            e.to_string()
        })?;
    let mic_stream = Arc::new(mic_stream);
    
    // Create system audio stream
    let system_stream = AudioStream::from_device(system_device.clone(), is_running.clone())
        .await
        .map_err(|e| {
            log_error!("Failed to create system stream: {}", e);
            e.to_string()
        })?;
    let system_stream = Arc::new(system_stream);

    unsafe {
        MIC_STREAM = Some(mic_stream.clone());
        SYSTEM_STREAM = Some(system_stream.clone());
        IS_RUNNING = Some(is_running.clone());
    }
    
    // Phase 2b round 2: register a fresh flush signal for this session.
    // The transcription task will notify_one() after sending its final
    // partial chunk; stop_recording awaits this before tearing down so
    // late transcripts arrive in transcriptsRef before recording-saving
    // fires.
    let flush_notify = Arc::new(Notify::new());
    {
        let signal = app.state::<FlushSignal>();
        let mut slot = signal.inner.lock().await;
        *slot = Some(flush_notify.clone());
    }
    let flush_notify_for_task = flush_notify.clone();

    // Create audio receivers
    let mic_receiver = mic_stream.subscribe().await;
    let mut mic_receiver_clone = mic_receiver.resubscribe();
    let mut system_receiver = system_stream.subscribe().await;

    let device_config = mic_stream.device_config.clone();
    let _device_name = mic_stream.device.to_string();
    let sample_rate = device_config.sample_rate().0;
    let channels = device_config.channels();

    tokio::spawn(async move {
        log_info!("Mic config: {} Hz, {} channels", sample_rate, channels);

        // Phase 4 Task 1C: this task only buffers samples now. Whisper
        // chunking, the transcript accumulator, and the per-chunk POST
        // to localhost:8178 are all gone — transcription happens once
        // at end-of-recording in stop_recording / save_session_to_backend
        // via Gemini.
        while is_running.load(Ordering::SeqCst) {
            let mut got_mic_samples = false;
            while let Ok(chunk) = mic_receiver_clone.try_recv() {
                got_mic_samples = true;
                log_debug!("Received {} mic samples", chunk.len());
                unsafe {
                    if let Some(buffer) = &MIC_BUFFER {
                        if let Ok(mut guard) = buffer.lock() {
                            guard.extend(chunk);
                        }
                    }
                }
            }
            if !got_mic_samples {
                log_debug!("No mic samples received, resubscribing to clear channel");
                mic_receiver_clone = mic_stream.subscribe().await;
            }

            let mut got_system_samples = false;
            while let Ok(chunk) = system_receiver.try_recv() {
                got_system_samples = true;
                log_debug!("Received {} system samples", chunk.len());
                unsafe {
                    if let Some(buffer) = &SYSTEM_BUFFER {
                        if let Ok(mut guard) = buffer.lock() {
                            guard.extend(chunk);
                        }
                    }
                }
            }
            if !got_system_samples {
                log_debug!("No system samples received, resubscribing to clear channel");
                system_receiver = system_stream.subscribe().await;
            }

            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // Phase 4 Task 1C: end-of-recording flush is no longer needed —
        // there's no in-flight chunk to drain because we're not chunking.
        // The whole buffer is consumed by stop_recording. flush_notify
        // still fires so stop_recording's existing await unblocks.
        flush_notify_for_task.notify_one();
        log_info!("Audio buffer task ended");
    });

    Ok(())
}

#[tauri::command]
async fn stop_recording<R: Runtime>(
    args: RecordingArgs,
    app: AppHandle<R>,
) -> Result<(), String> {
    log_info!("Attempting to stop recording...");

    // Only check recording state if we haven't already started stopping
    if !RECORDING_FLAG.load(Ordering::SeqCst) {
        log_info!("Recording is already stopped");
        return Ok(());
    }

    // Check minimum recording duration
    let elapsed_ms = unsafe {
        RECORDING_START_TIME
            .map(|start| start.elapsed().as_millis() as u64)
            .unwrap_or(0)
    };

    if elapsed_ms < MIN_RECORDING_DURATION_MS {
        let remaining = MIN_RECORDING_DURATION_MS - elapsed_ms;
        log_info!("Waiting for minimum recording duration ({} ms remaining)...", remaining);
        tokio::time::sleep(Duration::from_millis(remaining)).await;
    }

    // First set the recording flag to false to prevent new data from being processed
    RECORDING_FLAG.store(false, Ordering::SeqCst);
    log_info!("Recording flag set to false");

    // Phase 2b round 2: grab the flush signal for this session BEFORE we
    // flip is_running. The transcription task will notify_one() after its
    // final-chunk flush; we await that here so stream teardown doesn't
    // race the in-flight whisper-server request.
    let signal = app.state::<FlushSignal>();
    let flush_notify: Option<Arc<Notify>> = signal.inner.lock().await.clone();

    // Phase 4 Task 1C: capture the device sample rate BEFORE clearing
    // the stream refs.
    //
    // Phase 8 Task 12: capture BOTH mic and system rates independently.
    // The previous single-rate path assumed they matched, but the mic
    // is often 16/44.1 kHz while WASAPI loopback is almost always
    // 48 kHz on Windows — mixing sample-by-sample produced a WAV that
    // played the system audio at the wrong rate (slow-motion, low
    // pitch). mix_to_mono_wav_bytes now takes both rates and resamples
    // each buffer to a common 16 kHz target before mixing.
    let mic_sample_rate: u32 = unsafe {
        MIC_STREAM
            .as_ref()
            .map(|s| s.device_config.sample_rate().0)
            .unwrap_or(48_000)
    };
    let system_sample_rate: u32 = unsafe {
        SYSTEM_STREAM
            .as_ref()
            .map(|s| s.device_config.sample_rate().0)
            .unwrap_or(48_000)
    };
    log_info!(
        "stop_recording: mic_sample_rate={} system_sample_rate={}",
        mic_sample_rate,
        system_sample_rate
    );

    unsafe {
        // Stop the running flag for audio streams first
        if let Some(is_running) = &IS_RUNNING {
            // Set running flag to false first to stop the tokio task
            is_running.store(false, Ordering::SeqCst);
            log_info!("Set recording flag to false, waiting for buffer task flush...");

            if let Some(notify) = flush_notify {
                tokio::select! {
                    _ = notify.notified() => {
                        log_info!("Buffer task flush completed");
                    }
                    _ = tokio::time::sleep(Duration::from_secs(10)) => {
                        log_error!(
                            "Buffer task flush timed out after 10s — \
                             proceeding with teardown anyway"
                        );
                    }
                }
            } else {
                log_info!("No flush signal registered; falling back to fixed sleep");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }

            // Stop mic stream if it exists
            if let Some(mic_stream) = &MIC_STREAM {
                log_info!("Stopping microphone stream...");
                if let Err(e) = mic_stream.stop().await {
                    log_error!("Error stopping mic stream: {}", e);
                } else {
                    log_info!("Microphone stream stopped successfully");
                }
            }

            // Stop system stream if it exists
            if let Some(system_stream) = &SYSTEM_STREAM {
                log_info!("Stopping system stream...");
                if let Err(e) = system_stream.stop().await {
                    log_error!("Error stopping system stream: {}", e);
                } else {
                    log_info!("System stream stopped successfully");
                }
            }

            // Clear the stream references
            MIC_STREAM = None;
            SYSTEM_STREAM = None;
            IS_RUNNING = None;

            // Give streams time to fully clean up
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    // Get final buffers
    let mic_data = unsafe {
        if let Some(buffer) = &MIC_BUFFER {
            if let Ok(guard) = buffer.lock() {
                guard.clone()
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        }
    };

    let system_data = unsafe {
        if let Some(buffer) = &SYSTEM_BUFFER {
            if let Ok(guard) = buffer.lock() {
                guard.clone()
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        }
    };

    // Phase 4 Task 1C: build the WAV bytes synchronously here (in-memory,
    // fast) and stash on the session. The actual upload to Gemini
    // happens in save_session_to_backend, which is spawned after we
    // return so the user sees `Idle` immediately rather than waiting
    // for the network call.
    if !mic_data.is_empty() || !system_data.is_empty() {
        log_info!(
            "stop_recording: mixing {} mic samples @ {} Hz + {} system samples @ {} Hz",
            mic_data.len(),
            mic_sample_rate,
            system_data.len(),
            system_sample_rate
        );
        match mix_to_mono_wav_bytes(
            &mic_data,
            &system_data,
            mic_sample_rate,
            system_sample_rate,
        ) {
            Ok(wav_bytes) => {
                log_info!(
                    "stop_recording: encoded {} WAV bytes for transcription",
                    wav_bytes.len()
                );
                let session_state = app.state::<SessionState>();
                let mut slot = session_state.inner.lock().await;
                if let Some(ref mut session) = *slot {
                    session.pending_audio_wav = Some(wav_bytes);
                }
            }
            Err(e) => {
                log_error!("stop_recording: failed to encode WAV: {}", e);
            }
        }
    } else {
        log_info!("stop_recording: no audio captured; skipping WAV encode");
    }
    // Create the save directory if it doesn't exist
    if let Some(parent) = std::path::Path::new(&args.save_path).parent() {
        if !parent.exists() {
            log_info!("Creating directory: {:?}", parent);
            if let Err(e) = std::fs::create_dir_all(parent) {
                let err_msg = format!("Failed to create save directory: {}", e);
                log_error!("{}", err_msg);
                return Err(err_msg);
            }
        }
    }

    // Clean up
    unsafe {
        MIC_BUFFER = None;
        SYSTEM_BUFFER = None;
        MIC_STREAM = None;
        SYSTEM_STREAM = None;
        IS_RUNNING = None;
        RECORDING_START_TIME = None;
    }
    // Phase 6 Task 4 (Option 1): clear the system-only flag so the
    // next recording defaults back to the normal mic+system mix.
    SYSTEM_AUDIO_ONLY.store(false, Ordering::SeqCst);

    Ok(())
}

#[tauri::command]
fn is_recording() -> bool {
    RECORDING_FLAG.load(Ordering::SeqCst)
}

/// Phase 6 Task 4 (Option 1): start a manual recording that captures
/// system audio only (no mic input). For browser content (Loom,
/// Vimeo, podcast players, anything that isn't a meeting). The
/// SYSTEM_AUDIO_ONLY flag is checked at mix time, so the audio
/// capture path stays unchanged — we still subscribe to both
/// streams; the mic data just gets discarded when encoding the
/// final WAV.
#[tauri::command]
async fn manual_start_system_audio_only(
    control: tauri::State<'_, ControlChannel>,
) -> Result<(), String> {
    SYSTEM_AUDIO_ONLY.store(true, Ordering::SeqCst);
    control
        .0
        .send(ControlEvent::ManualStart)
        .await
        .map_err(|e| {
            // Roll back the flag if the send failed so a subsequent
            // normal recording isn't accidentally system-only.
            SYSTEM_AUDIO_ONLY.store(false, Ordering::SeqCst);
            e.to_string()
        })
}

#[tauri::command]
fn read_audio_file(file_path: String) -> Result<Vec<u8>, String> {
    match std::fs::read(&file_path) {
        Ok(data) => Ok(data),
        Err(e) => Err(format!("Failed to read audio file: {}", e))
    }
}

#[tauri::command]
async fn save_transcript(file_path: String, content: String) -> Result<(), String> {
    log::info!("Saving transcript to: {}", file_path);

    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(&file_path).parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }

    // Write content to file
    std::fs::write(&file_path, content)
        .map_err(|e| format!("Failed to write transcript: {}", e))?;

    log::info!("Transcript saved successfully");
    Ok(())
}

// Helper function to convert stereo to mono
fn stereo_to_mono(stereo: &[i16]) -> Vec<i16> {
    let mut mono = Vec::with_capacity(stereo.len() / 2);
    for chunk in stereo.chunks_exact(2) {
        let left = chunk[0] as i32;
        let right = chunk[1] as i32;
        let combined = ((left + right) / 2) as i16;
        mono.push(combined);
    }
    mono
}

#[tauri::command]
fn set_auth_token(token: String) {
    store_auth_token(if token.is_empty() { None } else { Some(token) });
}

// ===== Phase 2a: state machine commands =====

/// State exposed to Tauri commands so the frontend can send control events.
struct ControlChannel(mpsc::Sender<ControlEvent>);

#[tauri::command]
async fn get_recorder_state(
    sm: tauri::State<'_, SharedStateMachine>,
) -> Result<RecorderState, String> {
    Ok(sm.lock().await.current_state())
}

#[tauri::command]
async fn manual_start(
    control: tauri::State<'_, ControlChannel>,
) -> Result<(), String> {
    control.0.send(ControlEvent::ManualStart).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn manual_stop(
    control: tauri::State<'_, ControlChannel>,
) -> Result<(), String> {
    control.0.send(ControlEvent::ManualStop).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_auto_record(
    enabled: bool,
    control: tauri::State<'_, ControlChannel>,
) -> Result<(), String> {
    control
        .0
        .send(ControlEvent::AutoRecordToggled(enabled))
        .await
        .map_err(|e| e.to_string())
}

/// Phase 4 Task 1B: replace the per-app detection allowlist. The
/// frontend invokes this after PATCH /settings succeeds with the
/// freshly-saved `auto_record_sources` list, so toggling a source in
/// the Settings page takes effect immediately without a Rust restart.
///
/// Source keys are canonical lowercase identifiers ("teams", "meet",
/// "zoom", "webex", "discord"). Unknown keys are accepted (they just
/// don't gate any current detector); the master auto-record toggle
/// remains in `set_auto_record`.
#[tauri::command]
async fn set_auto_record_sources(
    sources: Vec<String>,
    enabled: tauri::State<'_, detector::EnabledSources>,
) -> Result<(), String> {
    enabled.replace(sources);
    Ok(())
}

/// Phase 2b round 4: returns the current recording state plus the
/// active session metadata (or all-None for Idle). The frontend calls
/// this on mount to reconcile after a refresh: if Rust says we're
/// Recording, the UI re-renders the recording indicator without needing
/// the React-side state that the refresh just wiped.
#[tauri::command]
async fn get_recording_state(
    sm: tauri::State<'_, SharedStateMachine>,
    session: tauri::State<'_, SessionState>,
) -> Result<RecordingStateSnapshot, String> {
    let state = sm.lock().await.current_state();
    let state_str = format!("{:?}", state);
    let slot = session.inner.lock().await;
    Ok(match slot.as_ref() {
        Some(s) => RecordingStateSnapshot {
            state: state_str,
            meeting_id: Some(s.meeting_id.clone()),
            title: Some(s.title.clone()),
            detection_source: Some(s.detection_source.clone()),
            detection_confidence: Some(s.detection_confidence.clone()),
            started_at: Some(s.started_at.clone()),
            is_manual: Some(s.is_manual),
        },
        None => RecordingStateSnapshot {
            state: state_str,
            meeting_id: None,
            title: None,
            detection_source: None,
            detection_confidence: None,
            started_at: None,
            is_manual: None,
        },
    })
}

/// Phase 2b round 6: returns the active session's transcript buffer
/// so the frontend can bootstrap its live transcript view when it
/// mounts mid-recording.
///
/// Phase 2b round 7: gated on the FSM state. Only Recording or
/// Finalizing are "active" — any other state returns an empty Vec.
/// Without this gate, a frontend that calls during a window where
/// the slot still happens to hold data (e.g. between FSM Idle and the
/// next StartRecording) could seed itself with stale transcripts. The
/// FSM state is the single source of truth for "is a session live."
#[tauri::command]
async fn get_session_transcripts(
    sm: tauri::State<'_, SharedStateMachine>,
    session: tauri::State<'_, SessionState>,
) -> Result<Vec<TranscriptUpdate>, String> {
    let state = sm.lock().await.current_state();
    let active = matches!(
        state,
        state_machine::RecorderState::Recording | state_machine::RecorderState::Finalizing
    );
    if !active {
        return Ok(Vec::new());
    }
    let slot = session.inner.lock().await;
    Ok(slot.as_ref().map(|s| s.transcripts.clone()).unwrap_or_default())
}

/// Phase 2b round 4: payload for the `meeting-saved` Tauri event the
/// action handler emits after a successful POST. The frontend uses
/// `meeting_id` to navigate to /meeting-details/<id>.
#[derive(Debug, Serialize, Clone)]
struct MeetingSavedEvent {
    meeting_id: String,
    title: String,
    detection_source: String,
    detection_confidence: String,
    is_manual: bool,
    transcript_count: usize,
}

#[derive(Debug, Serialize, Clone)]
struct MeetingSaveFailedEvent {
    meeting_id: String,
    error: String,
}

/// Phase 5 Task 1: payload for the new `save-failed` Tauri event the
/// frontend listens for to surface a sticky toast pointing the user
/// at the recovery WAV. `kind` distinguishes which leg failed —
/// "transcribe" (POST /transcribe-audio refused or 5xx'd) or
/// "save-transcript" (transcription succeeded but the meeting row
/// couldn't be written). `recovery_path` is an absolute filesystem
/// path the user can paste into the recover_recording.py script
/// once the backend is back up.
#[derive(Debug, Serialize, Clone)]
struct SaveFailedEvent {
    kind: String,
    recovery_path: String,
    error: String,
    meeting_id: Option<String>,
}

/// Phase 2b round 4: POST the session to `/save-transcript`, then emit
/// `meeting-saved` (or `meeting-save-failed` on error). No retry — that's
/// a Phase 3 conversation. We do log loudly so a backend outage is
/// obvious.
///
/// Phase 5 Task 1: durable recovery. The captured audio WAV is now
/// written to `%APPDATA%\NeatoRewind\recovery\recording-{ts}.wav`
/// BEFORE any backend POST is attempted. If `/transcribe-audio` or
/// `/save-transcript` fails (refused, timeout, non-2xx), the WAV
/// stays on disk and a `save-failed` Tauri event surfaces a sticky
/// toast with the recovery path. The WAV is deleted only on full
/// end-to-end success. This closes the silent-data-loss window where
/// stopping a recording with the backend down used to lose the audio
/// permanently.
async fn save_session_to_backend<R: Runtime>(
    app: &AppHandle<R>,
    mut session: RecordingSession,
) {
    use serde_json::json;

    // Phase 5 Task 1: write the WAV to disk first thing. If anything
    // below this point fails (network, backend down, Gemini rejected
    // the audio, /save-transcript 500'd, etc.), the user's audio is
    // still on disk and recoverable via scripts/recover_recording.py.
    let recovery_path: Option<std::path::PathBuf> =
        if let Some(ref wav_bytes) = session.pending_audio_wav {
            match write_recovery_wav(app, wav_bytes) {
                Ok(p) => {
                    tracing::info!(
                        "Wrote recovery WAV ({} bytes) to {:?}",
                        wav_bytes.len(),
                        p
                    );
                    Some(p)
                }
                Err(e) => {
                    tracing::error!(
                        "Failed to write recovery WAV: {} — proceeding without recovery insurance",
                        e
                    );
                    None
                }
            }
        } else {
            None
        };

    // Helper to emit save-failed and abort the rest of this save flow.
    // Returns nothing — caller should `return` after invoking. Also
    // emits the legacy `meeting-save-failed` for backward compat with
    // any listener that hasn't migrated to the new event yet.
    let emit_failure = |kind: &str, error: String| {
        let path_str = recovery_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !path_str.is_empty() {
            tracing::warn!(
                "Save flow failed at {}: {}. Recovery WAV preserved at {}",
                kind, error, path_str
            );
        } else {
            tracing::warn!("Save flow failed at {}: {} (no recovery WAV)", kind, error);
        }
        let payload = SaveFailedEvent {
            kind: kind.to_string(),
            recovery_path: path_str,
            error: error.clone(),
            meeting_id: Some(session.meeting_id.clone()),
        };
        if let Err(e) = app.emit("save-failed", payload) {
            tracing::warn!("Failed to emit save-failed event: {}", e);
        }
        // Legacy event for the existing SidebarProvider listener.
        let _ = app.emit(
            "meeting-save-failed",
            MeetingSaveFailedEvent {
                meeting_id: session.meeting_id.clone(),
                error,
            },
        );
    };

    // Phase 4 Task 1C: upload the WAV to /transcribe-audio. Failure
    // is now FATAL to the save flow (was previously swallowed) — the
    // recovery WAV is the user's safety net.
    if let Some(wav_bytes) = session.pending_audio_wav.take() {
        tracing::info!(
            "Transcribing {} WAV bytes for session {}",
            wav_bytes.len(),
            session.meeting_id
        );
        match transcribe_via_backend(wav_bytes).await {
            Ok(transcript) => {
                let trimmed = transcript.trim();
                if !trimmed.is_empty() {
                    let update = TranscriptUpdate {
                        text: trimmed.to_string(),
                        timestamp: "00:00".to_string(),
                        source: "Mixed Audio".to_string(),
                    };
                    // Mirror the live-transcript event shape so the
                    // meeting-details view's existing transcript-update
                    // listener picks it up if the user has the page
                    // open.
                    if let Err(e) = app.emit("transcript-update", update.clone()) {
                        tracing::warn!("Failed to emit transcript-update: {}", e);
                    }
                    session.transcripts.push(update);
                    tracing::info!(
                        "Transcription completed for {}: {} chars",
                        session.meeting_id,
                        trimmed.len()
                    );
                } else {
                    tracing::warn!(
                        "Transcription returned empty text for {}",
                        session.meeting_id
                    );
                }
            }
            Err(e) => {
                tracing::error!(
                    "Gemini transcription failed for {}: {}",
                    session.meeting_id, e
                );
                emit_failure("transcribe", e);
                return;
            }
        }
    }

    // Defensive filter (legacy whisper silence markers etc.) — Gemini
    // shouldn't produce these but the filter is cheap insurance.
    let real_transcripts: Vec<TranscriptUpdate> = session
        .transcripts
        .iter()
        .filter(|t| {
            let lower = t.text.trim().to_lowercase();
            !lower.is_empty()
                && lower != "[ silence ]"
                && lower != "[silence]"
                && lower != "(silence)"
                && lower != "[blank_audio]"
        })
        .cloned()
        .collect();

    if real_transcripts.is_empty() {
        tracing::warn!(
            "Session {} has no transcribed content; skipping /save-transcript",
            session.meeting_id
        );
        return;
    }

    // Backend expects each transcript to have an id field. The frontend
    // used `${Date.now()}-${counter}`; we use the same shape on the
    // wire (the column is just a string, never validated).
    let transcripts_json: Vec<serde_json::Value> = real_transcripts
        .iter()
        .enumerate()
        .map(|(i, t)| {
            json!({
                "id": format!("{}-{}", chrono::Utc::now().timestamp_millis(), i),
                "text": t.text,
                "timestamp": t.timestamp,
            })
        })
        .collect();

    let body = json!({
        "meeting_id": session.meeting_id,
        "meeting_title": session.title,
        "transcripts": transcripts_json,
        "detection_source": session.detection_source,
        "detection_confidence": session.detection_confidence,
    });

    tracing::info!(
        "POST /save-transcript: meeting_id={}, transcript_count={}, source={}, confidence={}",
        session.meeting_id,
        real_transcripts.len(),
        session.detection_source,
        session.detection_confidence
    );

    let client = reqwest::Client::new();
    let resp = client
        .post("http://127.0.0.1:5167/save-transcript")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            // Backend assigns its own meeting id; we read it back so the
            // frontend's navigation lands on the right URL.
            let server_meeting_id = match r.json::<serde_json::Value>().await {
                Ok(json) => json
                    .get("meeting_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&session.meeting_id)
                    .to_string(),
                Err(_) => session.meeting_id.clone(),
            };
            tracing::info!(
                "Meeting saved: server_id={}, transcript_count={}",
                server_meeting_id,
                real_transcripts.len()
            );
            let payload = MeetingSavedEvent {
                meeting_id: server_meeting_id,
                title: session.title,
                detection_source: session.detection_source,
                detection_confidence: session.detection_confidence,
                is_manual: session.is_manual,
                transcript_count: real_transcripts.len(),
            };
            if let Err(e) = app.emit("meeting-saved", payload) {
                tracing::warn!("Failed to emit meeting-saved: {}", e);
            }
            // Phase 5 Task 1: full end-to-end success — delete the
            // recovery WAV. Best-effort; a stale file just costs disk
            // space and the user can clean it up themselves.
            if let Some(p) = recovery_path.as_ref() {
                if let Err(e) = std::fs::remove_file(p) {
                    tracing::warn!(
                        "Recovery WAV cleanup failed at {:?}: {}",
                        p, e
                    );
                } else {
                    tracing::info!("Recovery WAV deleted: {:?}", p);
                }
            }
        }
        Ok(r) => {
            let status = r.status();
            let body_text = r
                .text()
                .await
                .unwrap_or_else(|_| "<no body>".to_string());
            tracing::error!(
                "/save-transcript returned {}: {}",
                status,
                body_text
            );
            emit_failure(
                "save-transcript",
                format!("HTTP {}: {}", status, body_text),
            );
        }
        Err(e) => {
            tracing::error!("/save-transcript request error: {}", e);
            emit_failure("save-transcript", e.to_string());
        }
    }
}

/// Phase 5 Task 1: write the captured WAV to a recovery directory
/// keyed by timestamp. Returns the absolute path on success so the
/// `save-failed` event payload can point the user there.
fn write_recovery_wav<R: Runtime>(
    app: &AppHandle<R>,
    wav_bytes: &[u8],
) -> Result<std::path::PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir resolve failed: {}", e))?;
    let recovery_dir = app_data_dir.join("recovery");
    std::fs::create_dir_all(&recovery_dir)
        .map_err(|e| format!("create_dir_all({:?}): {}", recovery_dir, e))?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S");
    let recovery_path = recovery_dir.join(format!("recording-{}.wav", stamp));
    std::fs::write(&recovery_path, wav_bytes)
        .map_err(|e| format!("write({:?}): {}", recovery_path, e))?;
    Ok(recovery_path)
}

/// Build a default save path for auto-recordings. Phase 2a uses a temp file
/// under the system temp dir; Phase 2b will let the user configure storage.
fn default_auto_save_path() -> String {
    let dir = std::env::temp_dir().join("neato-rewind");
    let _ = std::fs::create_dir_all(&dir);
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S");
    dir.join(format!("auto-{}.wav", ts)).to_string_lossy().into_owned()
}

fn detection_source_label(src: &DetectionSource) -> String {
    match src {
        DetectionSource::Process(name) => name.clone(),
        DetectionSource::WindowTitle(label) => label.clone(),
        DetectionSource::AudioActivity => "audio activity".to_string(),
        // Phase 2c round 1.3: include the "(mic+speaker)" suffix so the
        // persisted detection_source clearly indicates which path
        // triggered the recording. This is the strongest signal we
        // have — worth surfacing to the user via the meeting row.
        DetectionSource::MicAndSpeakerActive(name) => {
            format!("{} (mic+speaker)", name)
        }
        // Muted-listener path: the meeting process is rendering call audio
        // even without the user's mic active.
        DetectionSource::MeetingSpeakerActive(name) => {
            format!("{} (speaker)", name)
        }
        // Phase 6 Task 5: keep the raw browser process name on the
        // meeting row's detection_source field for diagnostic value;
        // the user-facing title goes through friendly_app_name which
        // collapses all browsers to "Browser".
        DetectionSource::BrowserAudio(name) => {
            format!("{} (browser audio)", name)
        }
        DetectionSource::Manual => "manual recording".to_string(),
    }
}

/// Phase 3 Task 3: maps a raw detection-source label (process name with
/// .exe, mic+speaker suffix, or window-title pattern) to a clean,
/// human-readable app name for sidebar display. Used in the meeting
/// title only — `detection_source` field on the meeting row keeps the
/// raw label for diagnostic / debugging value.
///
/// Falls back to the raw label if no mapping matches, so an unknown
/// source still produces a sensible (if uglier) title rather than
/// breaking.
fn friendly_app_name(label: &str) -> String {
    let lower = label.to_lowercase();
    // Strip the round-1.3 "(mic+speaker)" suffix and ".exe" so process-
    // derived labels normalize alongside window-title-derived ones.
    let stripped: String = lower
        .replace("(mic+speaker)", "")
        .replace("(browser audio)", "")
        .replace(".exe", "")
        .trim()
        .to_string();

    // Process-name-derived (post-strip) variants first.
    match stripped.as_str() {
        "ms-teams" | "teams" | "microsoft.teams" => return "Microsoft Teams".to_string(),
        "zoom" | "zoomus" | "cpthost" => return "Zoom".to_string(),
        "webex" | "webexmta" => return "Webex".to_string(),
        "skype" => return "Skype".to_string(),
        "g2mlauncher" | "g2mcomm" => return "GoToMeeting".to_string(),
        // Phase 6 Task 5: collapse all browsers to a single "Browser"
        // label in the session title. Distinguishing Chrome vs Edge
        // vs Firefox in the sidebar adds noise, not information —
        // what the user wants to know is "this wasn't a meeting, it
        // was browser audio (likely YouTube/Loom/etc.)".
        "chrome" | "msedge" | "firefox" | "brave" | "arc" | "opera" | "vivaldi" => {
            return "Browser".to_string()
        }
        _ => {}
    }

    // Window-title-derived labels (substring match — less precise but
    // covers the round-1.4 "Microsoft Teams Meeting" / "Microsoft Teams
    // Call" / "Teams Web Meeting" labels uniformly).
    if stripped.contains("microsoft teams") || stripped.contains("teams web") {
        return "Microsoft Teams".to_string();
    }
    if stripped.contains("google meet") {
        return "Google Meet".to_string();
    }
    if stripped.contains("zoom meeting")
        || stripped.contains("zoom webinar")
        || stripped.contains("zoom web meeting")
    {
        return "Zoom".to_string();
    }
    if stripped.contains("webex meeting") || stripped.contains("cisco webex") {
        return "Webex".to_string();
    }
    if stripped.contains("gotomeeting") {
        return "GoToMeeting".to_string();
    }

    // Fallback: keep the raw label so the user still sees something
    // meaningful even when the mapping doesn't match.
    label.to_string()
}

/// Phase 3 Task 3: friendly local-time stamp for sidebar titles.
/// Format: "May 1, 1:30 PM" — month abbreviation, no zero-padded day,
/// 12-hour clock with no zero-padded hour, AM/PM. Built from chrono
/// component accessors instead of `%-d`/`%-I` strftime modifiers so
/// behavior is identical across platforms (chrono's strftime support
/// for the `-` width-modifier varies by build).
fn format_meeting_timestamp() -> String {
    use chrono::{Datelike, Local, Timelike};
    let now = Local::now();
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = MONTHS
        .get((now.month().saturating_sub(1)) as usize)
        .copied()
        .unwrap_or("???");
    let day = now.day();
    let hour_24 = now.hour();
    let hour_12 = match hour_24 {
        0 => 12,
        h if h > 12 => h - 12,
        h => h,
    };
    let minute = now.minute();
    let am_pm = if hour_24 < 12 { "AM" } else { "PM" };
    format!("{} {}, {}:{:02} {}", month, day, hour_12, minute, am_pm)
}

/// Phase 2b round 6: emitted once per session start, for BOTH manual and
/// auto. Replaces round 4's auto-only `auto-recording-started` event.
/// The frontend listener (in SidebarProvider, where it stays attached
/// across all routes) populates the global recording context from this
/// payload — title, source, confidence are all here so no follow-up
/// IPC fetch is required.
#[derive(Debug, Serialize, Clone)]
struct RecordingStartedEvent {
    meeting_id: String,
    /// Canonical session title — "Auto: Google Meet" / "Recording 2026-04-30 21:50".
    title: String,
    /// Friendly source label — "Google Meet" / "ms-teams.exe" / "manual recording".
    label: String,
    /// "low" / "medium" / "high" / "none" / "manual".
    confidence: String,
    is_manual: bool,
}

pub fn run() {
    // Init tracing to an append-only log file so the detector + state-machine
    // decisions are visible in the packaged build (which has no console). The
    // file lives at %LOCALAPPDATA%\com.neatoventures.rewind\logs\rewind.log —
    // the same folder Tauri uses for app logs.
    let log_dir = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("com.neatoventures.rewind")
        .join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("rewind.log");
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(true)
        .with_ansi(false)
        .with_writer(move || -> Box<dyn std::io::Write + Send> {
            match std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                Ok(f) => Box::new(f),
                Err(_) => Box::new(std::io::sink()),
            }
        })
        .try_init();
    log::set_max_level(log::LevelFilter::Info);

    // ===== Phase 2a runtime wiring =====
    let rolling_buffer = Arc::new(RollingBuffer::new());
    let (detection_tx, mut detection_rx) = mpsc::channel(64);
    let (control_tx, mut control_rx) = mpsc::channel::<ControlEvent>(64);
    let (action_tx, mut action_rx) = mpsc::channel::<RecorderAction>(64);

    // Phase 4 Task 1B / Phase 7 Task 5: shared per-app gating set.
    // Created here (rather than inside setup) so the state machine
    // gets a clone — the FSM reads it to veto BrowserAudio-only
    // recording when the user has unchecked "Browser audio" in
    // Settings. The setup closure still owns the .manage() call so
    // the Tauri command handler can also access it.
    let enabled_sources = detector::EnabledSources::default();

    // Phase 2a default: auto_record_enabled starts ON. The orchestrator will
    // sync from the backend /settings/recording endpoint shortly after launch.
    let state_machine: SharedStateMachine = Arc::new(tokio::sync::Mutex::new(
        StateMachine::new(action_tx.clone(), true, enabled_sources.clone()),
    ));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .manage(rolling_buffer.clone())
        .manage(state_machine.clone())
        .manage(ControlChannel(control_tx.clone()))
        .manage(FlushSignal::default())
        .manage(SessionState::default())
        .setup(move |app| {
            log::info!("Application setup complete");

            // Trigger microphone permission request on startup
            if let Err(e) = audio::core::trigger_audio_permission() {
                log::error!("Failed to trigger audio permission: {}", e);
            }

            // Phase 8 Task 4: spawn the PyInstaller-bundled Python
            // backend sidecar. Release builds only — in `tauri dev`
            // the backend is run manually (uvicorn) per the historical
            // dev workflow, and double-spawning would collide on port
            // 5167. The sidecar's stdout/stderr are logged via Tauri's
            // CommandEvent stream so they're visible in the dev log
            // for troubleshooting MSI installs.
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_shell::ShellExt;
                use tauri_plugin_shell::process::CommandEvent;
                match app.shell().sidecar("neato-rewind-backend") {
                    // Cloud-mode config for the shipped app: the frozen
                    // Python backend ships with NO bundled key and must
                    // forward all AI to the proxy. ai_mode() /
                    // proxy_base_url() read these env vars, which are not
                    // otherwise present on a user's machine. Release-only
                    // (this whole block is #[cfg(not(debug_assertions))]),
                    // so `tauri dev` is unaffected.
                    Ok(sidecar) => match sidecar
                        .env("REWIND_AI_MODE", "cloud")
                        .env(
                            "REWIND_PROXY_URL",
                            "https://rewind-proxy-236465589949.us-west2.run.app",
                        )
                        .spawn()
                    {
                        Ok((mut rx, _child)) => {
                            log::info!("[sidecar] backend spawned");
                            tauri::async_runtime::spawn(async move {
                                while let Some(ev) = rx.recv().await {
                                    match ev {
                                        CommandEvent::Stdout(line) => {
                                            log::info!(
                                                "[backend stdout] {}",
                                                String::from_utf8_lossy(&line)
                                            );
                                        }
                                        CommandEvent::Stderr(line) => {
                                            log::info!(
                                                "[backend stderr] {}",
                                                String::from_utf8_lossy(&line)
                                            );
                                        }
                                        CommandEvent::Terminated(payload) => {
                                            log::warn!(
                                                "[sidecar] backend exited: {:?}",
                                                payload
                                            );
                                            break;
                                        }
                                        _ => {}
                                    }
                                }
                            });
                        }
                        Err(e) => log::error!(
                            "[sidecar] failed to spawn backend: {}", e
                        ),
                    },
                    Err(e) => log::error!(
                        "[sidecar] sidecar() lookup failed: {}", e
                    ),
                }
            }

            let app_handle = app.handle().clone();

            // Explicitly create the system tray icon. The auto-creation from
            // tauri.conf.json's app.trayIcon was unreliable in 2.0.6 — the icon
            // would not appear in the Windows notification area.
            {
                use tauri::Manager;
                use tauri::tray::TrayIconBuilder;
                use tauri::image::Image;

                // Try multiple icon-loading strategies in priority order. The
                // first that succeeds wins. We log every attempt so when the
                // tray ends up not appearing we can see WHICH layer failed.
                let cwd = std::env::current_dir().ok();
                tracing::info!("Tray init: cwd={:?}", cwd);

                let candidates: Vec<(&str, std::path::PathBuf)> = {
                    let mut v: Vec<(&str, std::path::PathBuf)> = Vec::new();

                    if let Ok(p) = app.path().resolve(
                        "icons/tray/tray-idle.png",
                        tauri::path::BaseDirectory::Resource,
                    ) {
                        v.push(("Resource:icons/tray/tray-idle.png", p));
                    }
                    if let Some(c) = cwd.as_ref() {
                        v.push((
                            "cwd:icons/tray/tray-idle.png",
                            c.join("icons/tray/tray-idle.png"),
                        ));
                        // icon.png is the bundled main app icon — known-good
                        // 18KB PNG that exists at frontend/src-tauri/icons/.
                        v.push(("cwd:icons/icon.png", c.join("icons/icon.png")));
                    }
                    if let Ok(p) = app.path().resolve(
                        "icons/icon.png",
                        tauri::path::BaseDirectory::Resource,
                    ) {
                        v.push(("Resource:icons/icon.png", p));
                    }
                    v
                };

                let mut chosen: Option<(&str, Image)> = None;
                for (label, path) in &candidates {
                    let exists = path.exists();
                    tracing::info!("Tray candidate [{}] -> {:?} exists={}", label, path, exists);
                    if !exists {
                        continue;
                    }
                    match Image::from_path(path) {
                        Ok(img) => {
                            tracing::info!("Tray icon loaded from [{}]", label);
                            chosen = Some((*label, img));
                            break;
                        }
                        Err(e) => {
                            tracing::warn!("Tray candidate [{}] failed Image::from_path: {}", label, e);
                        }
                    }
                }

                let icon = match chosen {
                    Some((_, img)) => img,
                    None => match app.default_window_icon().cloned() {
                        Some(img) => {
                            tracing::warn!(
                                "All tray icon candidates failed; falling back to default window icon"
                            );
                            img
                        }
                        None => {
                            tracing::error!(
                                "No tray icon could be loaded AND no default window icon — tray will not appear"
                            );
                            Image::new_owned(vec![255, 0, 0, 255], 1, 1)
                        }
                    },
                };

                match TrayIconBuilder::with_id("main")
                    .icon(icon)
                    .tooltip("Neato Rewind")
                    .build(app)
                {
                    Ok(_tray) => {
                        tracing::info!("Tray icon built successfully (id=main)");
                    }
                    Err(e) => {
                        tracing::error!("Failed to build tray icon: {}", e);
                    }
                }
            }

            // Phase 4 Task 1B: shared per-app filter consulted by the
            // state machine orchestrator before forwarding a detection
            // event to the FSM. Set on startup from /settings, updated
            // via the set_auto_record_sources Tauri command whenever
            // the user toggles a source in the Settings page.
            //
            // Phase 7 Task 5: the StateMachine ALSO holds a clone (via
            // its constructor) so it can read this set directly from
            // detection_confidence — needed for the BrowserAudio veto.
            // EnabledSources is Arc-internal, so .replace() updates
            // are visible to both readers without an extra channel.
            app.manage(enabled_sources.clone());

            // Sync auto_record_enabled + auto_record_sources from the
            // backend on startup so the FSM and detectors respect the
            // user's saved preferences. Best-effort — defaults to ON /
            // all-shipped-sources if the request fails. NOTE:
            // tauri::async_runtime::spawn (not tokio::spawn) — the
            // .setup closure runs outside an ambient tokio runtime.
            let control_tx_sync = control_tx.clone();
            let enabled_sources_sync = enabled_sources.clone();
            tauri::async_runtime::spawn(async move {
                // Phase 4 Task 1B: prefer the unified /settings response
                // (covers both flags). Fall back to /settings/recording
                // if /settings 404s on an old backend.
                let url = "http://127.0.0.1:5167/settings";
                match reqwest::get(url).await {
                    Ok(resp) if resp.status().is_success() => {
                        if let Ok(json) = resp.json::<serde_json::Value>().await {
                            if let Some(enabled) =
                                json.get("auto_record_enabled").and_then(|v| v.as_bool())
                            {
                                tracing::info!(
                                    "Synced auto_record_enabled from backend: {}",
                                    enabled
                                );
                                let _ = control_tx_sync
                                    .send(ControlEvent::AutoRecordToggled(enabled))
                                    .await;
                            }
                            if let Some(arr) = json
                                .get("auto_record_sources")
                                .and_then(|v| v.as_array())
                            {
                                let sources: Vec<String> = arr
                                    .iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect();
                                tracing::info!(
                                    "Synced auto_record_sources from backend: {:?}",
                                    sources
                                );
                                enabled_sources_sync.replace(sources);
                            }
                        }
                    }
                    Ok(resp) => tracing::warn!(
                        "Initial GET /settings returned {} — keeping defaults",
                        resp.status()
                    ),
                    Err(e) => tracing::warn!(
                        "Failed to fetch initial settings (backend may still be starting): {}",
                        e
                    ),
                }
            });

            // Detectors. Each watcher is an infinite loop, so the spawned
            // future should never resolve. If we ever see "task EXITED" in
            // the log, something killed it. JoinHandle isn't kept around
            // (drop is detach in tauri::async_runtime, same as tokio::spawn).
            // All three watchers send DetectionEvent into the same mpsc
            // channel; the state machine aggregates them via active_sources.
            //
            // Phase 2c round 1.2: a shared MeetingProcessFlag bridges
            // process detection → audio threshold profile selection.
            // The process watcher writes; the audio session watcher
            // reads. Without it, audio-only fire takes 15+ seconds
            // even when a meeting client is plainly running.
            let meeting_flag = detector::MeetingProcessFlag::new();

            let detection_tx_proc = detection_tx.clone();
            let meeting_flag_proc = meeting_flag.clone();
            tauri::async_runtime::spawn(async move {
                detector::process::run_process_watcher(
                    detection_tx_proc,
                    meeting_flag_proc,
                )
                .await;
                tracing::error!(
                    "Process watcher task EXITED — this should never happen. \
                     The detector is no longer running."
                );
            });

            let detection_tx_window = detection_tx.clone();
            tauri::async_runtime::spawn(async move {
                detector::window_title::run_window_watcher(detection_tx_window).await;
                tracing::error!("Window title watcher task EXITED");
            });

            let detection_tx_audio = detection_tx.clone();
            let meeting_flag_audio = meeting_flag.clone();
            tauri::async_runtime::spawn(async move {
                detector::audio_session::run_audio_session_watcher(
                    detection_tx_audio,
                    meeting_flag_audio,
                )
                .await;
                tracing::error!("Audio session watcher task EXITED");
            });

            // Phase 2c round 1.3: per-process WASAPI mic+speaker detector.
            // High-confidence "in a call" signal that fires within ~1.5s
            // of audio kicking in for known meeting processes. The state
            // machine treats MicAndSpeakerActive alone as High and the
            // POTENTIAL debounce drops to 3s. Total latency from joining
            // a Teams call to recording start: ~5s end-to-end.
            //
            // This is an addition, not a replacement, for the existing
            // amplitude-based audio_session detector — that one still
            // covers browser-mediated meetings (Google Meet etc.) which
            // round 1.3 deliberately leaves out of scope.
            let detection_tx_perproc = detection_tx.clone();
            tauri::async_runtime::spawn(async move {
                detector::audio_per_process::run_audio_per_process_watcher(
                    detection_tx_perproc,
                )
                .await;
                tracing::error!("Per-process audio watcher task EXITED");
            });

            // State machine orchestrator: pulls from detection_rx + control_rx
            let sm_orchestrator = state_machine.clone();
            let enabled_sources_orch = enabled_sources.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::select! {
                        Some(detection_evt) = detection_rx.recv() => {
                            // Phase 4 Task 1B: per-app filter. SignalLost
                            // events always pass through so disabling a
                            // source mid-recording cleanly drops the
                            // active flag in the FSM. Manual /
                            // AudioActivity / unknown source keys also
                            // pass — see source_allowed.
                            let pass = match &detection_evt {
                                detector::DetectionEvent::SignalDetected(src) => {
                                    detector::source_allowed(src, &enabled_sources_orch)
                                }
                                detector::DetectionEvent::SignalLost(_) => true,
                            };
                            if !pass {
                                continue;
                            }
                            sm_orchestrator
                                .lock()
                                .await
                                .handle(ControlEvent::Detection(detection_evt))
                                .await;
                        }
                        Some(control_evt) = control_rx.recv() => {
                            sm_orchestrator.lock().await.handle(control_evt).await;
                        }
                        else => break,
                    }
                }
            });

            // Ticker — drives time-based state transitions
            let sm_ticker = state_machine.clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(1));
                loop {
                    interval.tick().await;
                    sm_ticker.lock().await.tick().await;
                }
            });

            // Action handler — translates RecorderAction into side effects.
            //
            // Lifecycle events emitted to the frontend:
            //
            //   * `auto-recording-started`  — emitted on StartRecording for
            //     non-manual sources. UI hint that an auto session has begun;
            //     not load-bearing for persistence (see meeting-saved below).
            //   * `meeting-saved`           — Phase 2b round 4. Emitted after
            //     Rust has POSTed `/save-transcript` to the backend with the
            //     accumulated transcript buffer and detection metadata.
            //     Payload: { meeting_id, title, detection_source,
            //     detection_confidence }. Frontend listens to this and
            //     navigates to /meeting-details/<meeting_id>. Refresh-safe
            //     because Rust held everything across the React lifecycle.
            //   * `meeting-save-failed`     — Phase 2b round 4. Emitted if
            //     the POST returns non-2xx or the request errors. Payload:
            //     { meeting_id, error }. Frontend can surface to the user.
            //     No retry — that's a Phase 3 conversation.
            let app_for_actions = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(action) = action_rx.recv().await {
                    tracing::info!("RecorderAction: {:?}", action);
                    match action {
                        RecorderAction::StartRecording { source, confidence } => {
                            // Phase 2b round 4: Rust now generates the
                            // meeting_id at session start so the
                                // frontend can navigate to the right URL
                                // when meeting-saved fires.
                            let meeting_id = format!(
                                "meeting-{}",
                                chrono::Utc::now().timestamp_millis()
                            );
                            let label = detection_source_label(&source);
                            let is_manual = matches!(source, DetectionSource::Manual);
                            // Phase 3 Task 3: cleaner auto title format —
                            // "Auto: Microsoft Teams · May 1, 4:15 PM"
                            // instead of the diagnostic-grade
                            // "Auto: ms-teams.exe (mic+speaker)". The raw
                            // label is still persisted in the meeting row's
                            // detection_source field for debugging value;
                            // only the user-facing title uses the friendly
                            // form.
                            let title = if is_manual {
                                format!(
                                    "Recording {}",
                                    chrono::Utc::now().format("%Y-%m-%d %H:%M")
                                )
                            } else {
                                format!(
                                    "Auto: {} · {}",
                                    friendly_app_name(&label),
                                    format_meeting_timestamp()
                                )
                            };
                            let started_at =
                                chrono::Utc::now().to_rfc3339();
                            {
                                let session_state =
                                    app_for_actions.state::<SessionState>();
                                let mut slot = session_state.inner.lock().await;
                                *slot = Some(RecordingSession {
                                    meeting_id: meeting_id.clone(),
                                    title: title.clone(),
                                    detection_source: if is_manual {
                                        "manual".to_string()
                                    } else {
                                        label.clone()
                                    },
                                    detection_confidence: if is_manual {
                                        "manual".to_string()
                                    } else {
                                        confidence.as_str().to_string()
                                    },
                                    is_manual,
                                    started_at,
                                    transcripts: Vec::new(),
                                    pending_audio_wav: None,
                                });
                            }
                            tracing::info!(
                                "Session created: id={}, title={}, source={}, confidence={}",
                                meeting_id,
                                title,
                                if is_manual { "manual" } else { &label },
                                confidence.as_str()
                            );

                            // Reuse the existing recording entry point. We do not
                            // touch the cpal pipeline; we just call into it.
                            if let Err(e) = start_recording(app_for_actions.clone()).await {
                                tracing::error!("start_recording failed: {}", e);
                            } else {
                                tracing::info!(
                                    "Recording started (source: {}, confidence: {})",
                                    label,
                                    confidence.as_str()
                                );
                            }

                            // Phase 2b round 6: emit a single
                            // `recording-started` event for BOTH manual
                            // and auto sessions so SidebarProvider can
                            // populate its title/source/confidence
                            // without a follow-up IPC fetch. Replaces
                            // the round 4 auto-only `auto-recording-started`
                            // event. The frontend listener on this
                            // event lives in SidebarProvider so it
                            // fires regardless of which route the user
                            // is on.
                            let payload = RecordingStartedEvent {
                                meeting_id: meeting_id.clone(),
                                title: title.clone(),
                                label: label.clone(),
                                confidence: confidence.as_str().to_string(),
                                is_manual,
                            };
                            if let Err(e) = app_for_actions
                                .emit("recording-started", payload)
                            {
                                tracing::warn!(
                                    "Failed to emit recording-started: {}",
                                    e
                                );
                            }
                        }
                        RecorderAction::StopRecording => {
                            let path = default_auto_save_path();
                            if let Err(e) = stop_recording(
                                RecordingArgs { save_path: path },
                                app_for_actions.clone(),
                            )
                            .await
                            {
                                tracing::error!("stop_recording failed: {}", e);
                            }

                            // Phase 2b round 4: take the session out of the
                            // slot and POST it to the backend ourselves.
                            // Rust now owns persistence end-to-end. The
                            // post-loop flush has already pushed all final
                            // transcripts into session.transcripts via
                            // record_and_emit_transcript.
                            let session_opt = {
                                let session_state =
                                    app_for_actions.state::<SessionState>();
                                let mut slot = session_state.inner.lock().await;
                                slot.take()
                            };

                            // Phase 2b round 5 (Bug 2): emit recorder-state
                            // Idle BEFORE meeting-saved. The FSM tick has
                            // already transitioned to Idle but its
                            // StateChanged(Idle) action is queued behind
                            // this StopRecording — meaning it would normally
                            // fire AFTER meeting-saved, which is AFTER the
                            // frontend's router.push has unmounted the page
                            // listener. Emitting here is idempotent (the
                            // late StateChanged(Idle) repeats the same
                            // event, but the payload is "Idle" → "Idle" and
                            // the listener treats it as a no-op).
                            if let Err(e) = app_for_actions
                                .emit("recorder-state", RecorderState::Idle)
                            {
                                tracing::warn!(
                                    "Failed to emit pre-save Idle: {}",
                                    e
                                );
                            }

                            if let Some(session) = session_opt {
                                // Phase 6 Task 7: tell the UI we're now
                                // transcribing + saving. The whole
                                // pipeline can be 5-30s long, and
                                // without a visible signal users assume
                                // the app is broken when the meeting
                                // doesn't appear in the sidebar
                                // immediately. The frontend's
                                // ProcessingToast renders this; the
                                // existing meeting-saved / save-failed
                                // events clear it.
                                #[derive(serde::Serialize, Clone)]
                                struct TranscribingPayload {
                                    meeting_id: String,
                                    title: String,
                                }
                                if let Err(e) = app_for_actions.emit(
                                    "transcribing-started",
                                    TranscribingPayload {
                                        meeting_id: session.meeting_id.clone(),
                                        title: session.title.clone(),
                                    },
                                ) {
                                    tracing::warn!(
                                        "Failed to emit transcribing-started: {}",
                                        e
                                    );
                                }

                                // Phase 4 Task 1C: Gemini transcription
                                // can take 30-60s on a long recording.
                                // Spawn the save so the action queue
                                // keeps moving (a fresh auto-detect
                                // during the upload window shouldn't
                                // be blocked) and the recorder-state
                                // already reads Idle to the UI above.
                                let app_inner = app_for_actions.clone();
                                tokio::spawn(async move {
                                    save_session_to_backend(&app_inner, session).await;
                                });
                            } else {
                                tracing::warn!(
                                    "StopRecording fired with no session in slot — \
                                     skipping save. Probably a duplicate StopRecording."
                                );
                            }
                        }
                        RecorderAction::EnterFinalizing => {
                            // Signal the UI we're draining; the FINALIZING_DRAIN
                            // timer in the FSM will eventually emit StopRecording
                            // which is where the persistence event fires.
                            let _ = app_for_actions
                                .emit("recorder-state", RecorderState::Finalizing);
                        }
                        RecorderAction::StateChanged(state) => {
                            tray::update_tray_for_state(&app_for_actions, state);
                            let _ = app_for_actions.emit("recorder-state", state);

                            if state == RecorderState::Recording {
                                // Read the session label from the slot (set
                                // by the StartRecording branch a moment ago).
                                let label = {
                                    let session_state =
                                        app_for_actions.state::<SessionState>();
                                    let slot =
                                        session_state.inner.lock().await;
                                    slot.as_ref()
                                        .map(|s| s.detection_source.clone())
                                        .unwrap_or_else(|| {
                                            "your meeting".to_string()
                                        })
                                };
                                use tauri_plugin_notification::NotificationExt;
                                if let Err(e) = app_for_actions
                                    .notification()
                                    .builder()
                                    .title("Neato Rewind — recording started")
                                    .body(format!("Capturing {}", label))
                                    .show()
                                {
                                    tracing::warn!("Failed to show toast: {}", e);
                                }
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            is_recording,
            read_audio_file,
            save_transcript,
            get_recorder_state,
            get_recording_state,
            get_session_transcripts,
            manual_start,
            manual_start_system_audio_only,
            manual_stop,
            set_auto_record,
            set_auto_record_sources,
            set_auth_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
