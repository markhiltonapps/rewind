use std::fs;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::Duration;
use serde::{Deserialize, Serialize};

// Declare audio module
pub mod audio;
pub mod ollama;

// Phase 2a: detection + state machine + rolling buffer
pub mod detector;
pub mod state_machine;
pub mod rolling_buffer;
pub mod tray;

use audio::{
    default_input_device, default_output_device, AudioStream,
    encode_single_audio,
};
use ollama::{OllamaModel};
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
static mut MIC_BUFFER: Option<Arc<Mutex<Vec<f32>>>> = None;
static mut SYSTEM_BUFFER: Option<Arc<Mutex<Vec<f32>>>> = None;
static mut MIC_STREAM: Option<Arc<AudioStream>> = None;
static mut SYSTEM_STREAM: Option<Arc<AudioStream>> = None;
static mut IS_RUNNING: Option<Arc<AtomicBool>> = None;
static mut RECORDING_START_TIME: Option<std::time::Instant> = None;

// Audio configuration constants
const CHUNK_DURATION_MS: u32 = 30000; // 30 seconds per chunk for better sentence processing
const WHISPER_SAMPLE_RATE: u32 = 16000; // Whisper's required sample rate
const WAV_SAMPLE_RATE: u32 = 44100; // WAV file sample rate
const WAV_CHANNELS: u16 = 2; // Stereo for WAV files
const WHISPER_CHANNELS: u16 = 1; // Mono for Whisper API
const SENTENCE_TIMEOUT_MS: u64 = 1000; // Emit incomplete sentence after 1 second of silence
const MIN_CHUNK_DURATION_MS: u32 = 2000; // Minimum duration before sending chunk
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

#[derive(Debug, Deserialize)]
struct TranscriptSegment {
    text: String,
    t0: f32,
    t1: f32,
}

#[derive(Debug, Deserialize)]
struct TranscriptResponse {
    segments: Vec<TranscriptSegment>,
    buffer_size_ms: i32,
}

// Helper struct to accumulate transcript segments
#[derive(Debug)]
struct TranscriptAccumulator {
    current_sentence: String,
    sentence_start_time: f32,
    last_update_time: std::time::Instant,
    last_segment_hash: u64,
}

impl TranscriptAccumulator {
    fn new() -> Self {
        Self {
            current_sentence: String::new(),
            sentence_start_time: 0.0,
            last_update_time: std::time::Instant::now(),
            last_segment_hash: 0,
        }
    }

    fn add_segment(&mut self, segment: &TranscriptSegment) -> Option<TranscriptUpdate> {
        log_info!("Processing new transcript segment: {:?}", segment);
        
        // Update the last update time
        self.last_update_time = std::time::Instant::now();

        // Clean up the text (remove whisper silence/no-speech markers and trim).
        // [ Silence ] is what whisper.cpp emits for silent stretches; if we let
        // it through it ends up as the only saved row when the user clicks
        // stop during a quiet moment.
        let clean_text = segment.text
            .replace("[BLANK_AUDIO]", "")
            .replace("[AUDIO OUT]", "")
            .replace("[ Silence ]", "")
            .replace("[silence]", "")
            .replace("[Silence]", "")
            .replace("(silence)", "")
            .trim()
            .to_string();

        if !clean_text.is_empty() {
            log_info!("Clean transcript text: {}", clean_text);
        }

        // Skip empty segments or very short segments (less than 1 second)
        if clean_text.is_empty() || (segment.t1 - segment.t0) < 1.0 {
            return None;
        }

        // Calculate hash of this segment to detect duplicates
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        segment.text.hash(&mut hasher);
        segment.t0.to_bits().hash(&mut hasher);
        segment.t1.to_bits().hash(&mut hasher);
        let segment_hash = hasher.finish();

        // Skip if this is a duplicate segment
        if segment_hash == self.last_segment_hash {
            return None;
        }
        self.last_segment_hash = segment_hash;

        // If this is the start of a new sentence, store the start time
        if self.current_sentence.is_empty() {
            self.sentence_start_time = segment.t0;
        }

        // Add the new text with proper spacing
        if !self.current_sentence.is_empty() && !self.current_sentence.ends_with(' ') {
            self.current_sentence.push(' ');
        }
        self.current_sentence.push_str(&clean_text);

        // Check if we have a complete sentence
        if clean_text.ends_with('.') || clean_text.ends_with('?') || clean_text.ends_with('!') {
            let sentence = std::mem::take(&mut self.current_sentence);
            let update = TranscriptUpdate {
                text: sentence.trim().to_string(),
                timestamp: format!("{:.1} - {:.1}", self.sentence_start_time, segment.t1),
                source: "Mixed Audio".to_string(),
            };
            log_info!("Generated transcript update: {:?}", update);
            Some(update)
        } else {
            None
        }
    }

    fn check_timeout(&mut self) -> Option<TranscriptUpdate> {
        if !self.current_sentence.is_empty() && 
           self.last_update_time.elapsed() > Duration::from_millis(SENTENCE_TIMEOUT_MS) {
            let sentence = std::mem::take(&mut self.current_sentence);
            let current_time = self.sentence_start_time + (SENTENCE_TIMEOUT_MS as f32 / 1000.0);
            let update = TranscriptUpdate {
                text: sentence.trim().to_string(),
                timestamp: format!("{:.1} - {:.1}", self.sentence_start_time, current_time),
                source: "Mixed Audio".to_string(),
            };
            Some(update)
        } else {
            None
        }
    }
}

async fn send_audio_chunk(chunk: Vec<f32>, client: &reqwest::Client) -> Result<TranscriptResponse, String> {
    log_debug!("Preparing to send audio chunk of size: {}", chunk.len());
    
    // Convert f32 samples to bytes
    let bytes: Vec<u8> = chunk.iter()
        .flat_map(|&sample| {
            let clamped = sample.max(-1.0).min(1.0);
            clamped.to_le_bytes().to_vec()
        })
        .collect();
    
    // Retry configuration
    let max_retries = 3;
    let mut retry_count = 0;
    let mut last_error = String::new();

    while retry_count <= max_retries {
        if retry_count > 0 {
            // Exponential backoff: wait 2^retry_count * 100ms
            let delay = Duration::from_millis(100 * (2_u64.pow(retry_count as u32)));
            log::info!("Retry attempt {} of {}. Waiting {:?} before retry...", 
                      retry_count, max_retries, delay);
            tokio::time::sleep(delay).await;
        }

        // Create fresh multipart form for each attempt since Form can't be reused
        let part = Part::bytes(bytes.clone())
            .file_name("audio.raw")
            .mime_str("audio/x-raw")
            .unwrap();
        let form = Form::new().part("audio", part);

        match client.post("http://127.0.0.1:8178/stream")
            .multipart(form)
            .send()
            .await {
                Ok(response) => {
                    match response.json::<TranscriptResponse>().await {
                        Ok(transcript) => return Ok(transcript),
                        Err(e) => {
                            last_error = e.to_string();
                            log::error!("Failed to parse response: {}", last_error);
                        }
                    }
                }
                Err(e) => {
                    last_error = e.to_string();
                    log::error!("Request failed: {}", last_error);
                }
            }

        retry_count += 1;
    }

    Err(format!("Failed after {} retries. Last error: {}", max_retries, last_error))
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
    
    // Create HTTP client for transcription
    let client = reqwest::Client::new();

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

    // Start transcription task
    let app_handle = app.clone();
    
    // Create audio receivers
    let mut mic_receiver = mic_stream.subscribe().await;
    let mut mic_receiver_clone = mic_receiver.resubscribe();
    let mut system_receiver = system_stream.subscribe().await;
    
    // Create debug directory for chunks in temp
    let temp_dir = std::env::temp_dir();
    log_info!("System temp directory: {:?}", temp_dir);
    let debug_dir = temp_dir.join("meeting_minutes_debug");
    log_info!("Full debug directory path: {:?}", debug_dir);
    
    // Create directory and check if it exists
    fs::create_dir_all(&debug_dir).map_err(|e| {
        log_error!("Failed to create debug directory: {}", e);
        e.to_string()
    })?;
    
    if debug_dir.exists() {
        log_info!("Debug directory successfully created and exists");
    } else {
        log_error!("Failed to create debug directory - path does not exist after creation");
    }
    
    let chunk_counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let chunk_counter_clone = chunk_counter.clone();
    
    // Create transcript accumulator
    let mut accumulator = TranscriptAccumulator::new();
    
    let device_config = mic_stream.device_config.clone();
    let _device_name = mic_stream.device.to_string();
    let sample_rate = device_config.sample_rate().0;
    let channels = device_config.channels();
    
    tokio::spawn(async move {
        let chunk_samples = (WHISPER_SAMPLE_RATE as f32 * (CHUNK_DURATION_MS as f32 / 1000.0)) as usize;
        let min_samples = (WHISPER_SAMPLE_RATE as f32 * (MIN_CHUNK_DURATION_MS as f32 / 1000.0)) as usize;
        let mut current_chunk: Vec<f32> = Vec::with_capacity(chunk_samples);
        let mut last_chunk_time = std::time::Instant::now();
        
        log_info!("Mic config: {} Hz, {} channels", sample_rate, channels);
        
        while is_running.load(Ordering::SeqCst) {
            // Check for timeout on current sentence
            if let Some(update) = accumulator.check_timeout() {
                record_and_emit_transcript(&app_handle, update).await;
            }

            // Collect audio samples
            let mut new_samples = Vec::new();
            let mut mic_samples = Vec::new();
            let mut system_samples = Vec::new();
            
            // Get microphone samples
            let mut got_mic_samples = false;
            while let Ok(chunk) = mic_receiver_clone.try_recv() {
                got_mic_samples = true;
                log_debug!("Received {} mic samples", chunk.len());
                let chunk_clone = chunk.clone();
                mic_samples.extend(chunk);
                
                // Store in global buffer
                unsafe {
                    if let Some(buffer) = &MIC_BUFFER {
                        if let Ok(mut guard) = buffer.lock() {
                            guard.extend(chunk_clone);
                        }
                    }
                }
            }
            // If we didn't get any samples, try to resubscribe to clear any backlog
            if !got_mic_samples {
                log_debug!("No mic samples received, resubscribing to clear channel");
                mic_receiver_clone = mic_stream.subscribe().await;
            }
            
            // Get system audio samples
            let mut got_system_samples = false;
            while let Ok(chunk) = system_receiver.try_recv() {
                got_system_samples = true;
                log_debug!("Received {} system samples", chunk.len());
                let chunk_clone = chunk.clone();
                system_samples.extend(chunk);
                
                // Store in global buffer
                unsafe {
                    if let Some(buffer) = &SYSTEM_BUFFER {
                        if let Ok(mut guard) = buffer.lock() {
                            guard.extend(chunk_clone);
                        }
                    }
                }
            }
            // If we didn't get any samples, try to resubscribe to clear any backlog
            if !got_system_samples {
                log_debug!("No system samples received, resubscribing to clear channel");
                system_receiver = system_stream.subscribe().await;
            }
            
            // Mix samples with debug info
            let max_len = mic_samples.len().max(system_samples.len());
            for i in 0..max_len {
                let mic_sample = if i < mic_samples.len() { mic_samples[i] } else { 0.0 };
                let system_sample = if i < system_samples.len() { system_samples[i] } else { 0.0 };
                // Increase mic sensitivity by giving it more weight in the mix (80% mic, 20% system)
                new_samples.push((mic_sample * 0.7) + (system_sample * 0.3));
            }
            
            log_debug!("Mixed {} samples", new_samples.len());
            
            // Add samples to current chunk
            for sample in new_samples {
                current_chunk.push(sample);
            }
            
            // Check if we should send the chunk based on size or time
            let should_send = current_chunk.len() >= chunk_samples || 
                            (current_chunk.len() >= min_samples && 
                             last_chunk_time.elapsed() >= Duration::from_millis(CHUNK_DURATION_MS as u64));
            
            if should_send {
                log_info!("Should send chunk with {} samples", current_chunk.len());
                let chunk_to_send = current_chunk.clone();
                current_chunk.clear();
                last_chunk_time = std::time::Instant::now();
                
                // Save debug chunks
                let chunk_num = chunk_counter_clone.fetch_add(1, Ordering::SeqCst);
                log_info!("Processing chunk {}", chunk_num);
                
                // // Save mic chunk
                // if !mic_samples.is_empty() {
                //     let mic_chunk_path = debug_dir.join(format!("chunk_{}_mic.wav", chunk_num));
                //     log_info!("Saving mic chunk to {:?}", mic_chunk_path);
                //     let mic_bytes: Vec<u8> = mic_samples.iter()
                //         .flat_map(|&sample| {
                //             let clamped = sample.max(-1.0).min(1.0);
                //             clamped.to_le_bytes().to_vec()
                //         })
                //         .collect();
                //     if let Err(e) = encode_single_audio(
                //         &mic_bytes,
                //         WAV_SAMPLE_RATE,
                //         1, // Mono for mic
                //         &mic_chunk_path,
                //     ) {
                //         log_error!("Failed to save mic chunk {}: {}", chunk_num, e);
                //     } else {
                //         log_info!("Successfully saved mic chunk {} with {} samples", chunk_num, mic_samples.len());
                //     }
                // } else {
                //     log_info!("No mic samples to save for chunk {}", chunk_num);
                // }

                // Save system chunk
                // if !system_samples.is_empty() {
                //     let system_chunk_path = debug_dir.join(format!("chunk_{}_system.wav", chunk_num));
                //     log_info!("Saving system chunk to {:?}", system_chunk_path);
                //     let system_bytes: Vec<u8> = system_samples.iter()
                //         .flat_map(|&sample| {
                //             let clamped = sample.max(-1.0).min(1.0);
                //             clamped.to_le_bytes().to_vec()
                //         })
                //         .collect();
                //     if let Err(e) = encode_single_audio(
                //         &system_bytes,
                //         WAV_SAMPLE_RATE,
                //         2, // Stereo for system
                //         &system_chunk_path,
                //     ) {
                //         log_error!("Failed to save system chunk {}: {}", chunk_num, e);
                //     } else {
                //         log_info!("Successfully saved system chunk {} with {} samples", chunk_num, system_samples.len());
                //     }
                // } else {
                //     log_info!("No system samples to save for chunk {}", chunk_num);
                // }
                
                // Save mixed chunk
                // if !chunk_to_send.is_empty() {
                //     let mixed_chunk_path = debug_dir.join(format!("chunk_{}_mixed.wav", chunk_num));
                //     log_info!("Saving mixed chunk to {:?}", mixed_chunk_path);
                //     let mixed_bytes: Vec<u8> = chunk_to_send.iter()
                //         .flat_map(|&sample| {
                //             let clamped = sample.max(-1.0).min(1.0);
                //             clamped.to_le_bytes().to_vec()
                //         })
                //         .collect();
                //     match encode_single_audio(
                //         &mixed_bytes,
                //         WAV_SAMPLE_RATE,
                //         WAV_CHANNELS,
                //         &mixed_chunk_path,
                //     ) {
                //         Ok(_) => {
                //             log_info!("Successfully saved mixed chunk {} with {} samples", chunk_num, chunk_to_send.len());
                //         }
                //         Err(e) => {
                //             // Check if it's a broken pipe error
                //             if e.to_string().contains("Broken pipe") {
                //                 log_debug!("Broken pipe while saving chunk {} - this is expected during cleanup", chunk_num);
                //             } else {
                //                 log_error!("Failed to save mixed chunk {}: {}", chunk_num, e);
                //             }
                //         }
                //     }
                // } else {
                //     log_info!("No mixed samples to save for chunk {}", chunk_num);
                // }
                
                // Keep only last 10 chunks
                // if chunk_num > 10 {
                //     if let Ok(entries) = fs::read_dir(&debug_dir) {
                //         for entry in entries.flatten() {
                //             if let Some(name) = entry.file_name().to_str() {
                //                 if name.starts_with("chunk_") && 
                //                    name.ends_with(".wav") && 
                //                    !name.contains(&format!("chunk_{}", chunk_num)) {
                //                     let _ = fs::remove_file(entry.path());
                //                 }
                //             }
                //         }
                //     }
                // }
                
                // Process chunk for Whisper API
                let whisper_samples = if sample_rate != WHISPER_SAMPLE_RATE {
                    log_debug!("Resampling audio from {} to {}", sample_rate, WHISPER_SAMPLE_RATE);
                    resample_audio(
                        &chunk_to_send,
                        sample_rate,
                        WHISPER_SAMPLE_RATE,
                    )
                } else {
                    chunk_to_send
                };

                // Send chunk for transcription
                match send_audio_chunk(whisper_samples, &client).await {
                    Ok(response) => {
                        log_info!("Received {} transcript segments", response.segments.len());
                        for segment in response.segments {
                            log_info!("Processing segment: {} ({:.1}s - {:.1}s)", 
                                     segment.text.trim(), segment.t0, segment.t1);
                            // Add segment to accumulator and check for complete sentence
                            if let Some(update) = accumulator.add_segment(&segment) {
                                record_and_emit_transcript(&app_handle, update).await;
                            }
                        }
                    }
                    Err(e) => {
                        log_error!("Transcription error: {}", e);
                    }
                }
            }
            
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // Phase 2b round 2: flush the partially-filled chunk before tearing
        // down. The 30s drain in Finalizing lets in-flight 10s chunks
        // complete, but the LAST partial chunk (0–9.99s of audio at the mic
        // sample rate) was previously discarded and so the last spoken
        // sentence never made it into the saved transcript. Whisper-server
        // accepts variable-length chunks above MIN_CHUNK_DURATION_MS; if
        // our partial is below that threshold we pad with silence so the
        // server still processes it. Padding is imperfect (whisper sees an
        // artificially-extended segment) but preserves the spoken content,
        // which is what matters. See NEATO_NOTES.md.
        if !current_chunk.is_empty() {
            let pre_resample_min = (sample_rate as f32 * 2.0) as usize;
            if current_chunk.len() < pre_resample_min {
                log_info!(
                    "Flush: padding {} samples to {} (silence) before send",
                    current_chunk.len(),
                    pre_resample_min
                );
                current_chunk.resize(pre_resample_min, 0.0);
            }
            let chunk_to_flush = std::mem::take(&mut current_chunk);
            log_info!(
                "Flush: sending final {} samples to whisper-server",
                chunk_to_flush.len()
            );

            let whisper_samples = if sample_rate != WHISPER_SAMPLE_RATE {
                resample_audio(&chunk_to_flush, sample_rate, WHISPER_SAMPLE_RATE)
            } else {
                chunk_to_flush
            };

            match send_audio_chunk(whisper_samples, &client).await {
                Ok(response) => {
                    log_info!(
                        "Flush: received {} segments from final chunk",
                        response.segments.len()
                    );
                    for segment in response.segments {
                        if let Some(update) = accumulator.add_segment(&segment) {
                            record_and_emit_transcript(&app_handle, update).await;
                        }
                    }
                }
                Err(e) => log_error!("Flush transcription error: {}", e),
            }
        }

        // Emit any remaining transcript when recording stops (the
        // accumulator may have buffered a sentence-in-progress that the
        // flush above didn't produce a punctuated end for).
        if let Some(update) = accumulator.check_timeout() {
            record_and_emit_transcript(&app_handle, update).await;
        }

        // Phase 2b round 2: signal that the flush is complete so
        // stop_recording can proceed and the action handler can emit
        // recording-saving with confidence that all final transcripts have
        // been delivered to the frontend.
        flush_notify_for_task.notify_one();

        log_info!("Transcription task ended (flush complete)");
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

    unsafe {
        // Stop the running flag for audio streams first
        if let Some(is_running) = &IS_RUNNING {
            // Set running flag to false first to stop the tokio task
            is_running.store(false, Ordering::SeqCst);
            log_info!("Set recording flag to false, waiting for transcription flush...");

            if let Some(notify) = flush_notify {
                tokio::select! {
                    _ = notify.notified() => {
                        log_info!("Transcription flush completed");
                    }
                    _ = tokio::time::sleep(Duration::from_secs(10)) => {
                        log_error!(
                            "Transcription flush timed out after 10s — \
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
    /*
    // Mix the audio and convert to 16-bit PCM
    let max_len = mic_data.len().max(system_data.len());
    let mut mixed_data = Vec::with_capacity(max_len);
    
    for i in 0..max_len {
        let mic_sample = if i < mic_data.len() { mic_data[i] } else { 0.0 };
        let system_sample = if i < system_data.len() { system_data[i] } else { 0.0 };
        mixed_data.push((mic_sample + system_sample) * 0.5);
    }

    if mixed_data.is_empty() {
        log_error!("No audio data captured");
        return Err("No audio data captured".to_string());
    }
    
    log_info!("Mixed {} audio samples", mixed_data.len());
    
    // Resample the audio to 16kHz for Whisper compatibility
    let original_sample_rate = 48000; // Assuming original sample rate is 48kHz
    if original_sample_rate != WHISPER_SAMPLE_RATE {
        log_info!("Resampling audio from {} Hz to {} Hz for Whisper compatibility", 
                 original_sample_rate, WHISPER_SAMPLE_RATE);
        mixed_data = resample_audio(&mixed_data, original_sample_rate, WHISPER_SAMPLE_RATE);
        log_info!("Resampled to {} samples", mixed_data.len());
    }
    
    // Convert to 16-bit PCM samples
    let mut bytes = Vec::with_capacity(mixed_data.len() * 2);
    for &sample in mixed_data.iter() {
        let value = (sample.max(-1.0).min(1.0) * 32767.0) as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    
    log_info!("Converted to {} bytes of PCM data", bytes.len());

    // Create WAV header
    let data_size = bytes.len() as u32;
    let file_size = 36 + data_size;
    let sample_rate = WHISPER_SAMPLE_RATE; // Use Whisper's required sample rate (16000 Hz)
    let channels = 1u16; // Mono
    let bits_per_sample = 16u16;
    let block_align = channels * (bits_per_sample / 8);
    let byte_rate = sample_rate * block_align as u32;
    
    let mut wav_file = Vec::with_capacity(44 + bytes.len());
    
    // RIFF header
    wav_file.extend_from_slice(b"RIFF");
    wav_file.extend_from_slice(&file_size.to_le_bytes());
    wav_file.extend_from_slice(b"WAVE");
    
    // fmt chunk
    wav_file.extend_from_slice(b"fmt ");
    wav_file.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    wav_file.extend_from_slice(&1u16.to_le_bytes()); // audio format (PCM)
    wav_file.extend_from_slice(&channels.to_le_bytes()); // num channels
    wav_file.extend_from_slice(&sample_rate.to_le_bytes()); // sample rate
    wav_file.extend_from_slice(&byte_rate.to_le_bytes()); // byte rate
    wav_file.extend_from_slice(&block_align.to_le_bytes()); // block align
    wav_file.extend_from_slice(&bits_per_sample.to_le_bytes()); // bits per sample
    
    // data chunk
    wav_file.extend_from_slice(b"data");
    wav_file.extend_from_slice(&data_size.to_le_bytes());
    wav_file.extend_from_slice(&bytes);
    
    log_info!("Created WAV file with {} bytes total", wav_file.len());
    */
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

    /*
    // Save the recording
    log_info!("Saving recording to: {}", args.save_path);
    match fs::write(&args.save_path, wav_file) {
        Ok(_) => log_info!("Successfully saved recording"),
        Err(e) => {
            let err_msg = format!("Failed to save recording: {}", e);
            log_error!("{}", err_msg);
            return Err(err_msg);
        }
    }
    */
    
    // Clean up
    unsafe {
        MIC_BUFFER = None;
        SYSTEM_BUFFER = None;
        MIC_STREAM = None;
        SYSTEM_STREAM = None;
        IS_RUNNING = None;
        RECORDING_START_TIME = None;
    }
    
    Ok(())
}

#[tauri::command]
fn is_recording() -> bool {
    RECORDING_FLAG.load(Ordering::SeqCst)
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
/// mounts mid-recording. Empty Vec if Idle.
#[tauri::command]
async fn get_session_transcripts(
    session: tauri::State<'_, SessionState>,
) -> Result<Vec<TranscriptUpdate>, String> {
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

/// Phase 2b round 4: POST the session to `/save-transcript`, then emit
/// `meeting-saved` (or `meeting-save-failed` on error). No retry — that's
/// a Phase 3 conversation. We do log loudly so a backend outage is
/// obvious.
async fn save_session_to_backend<R: Runtime>(
    app: &AppHandle<R>,
    session: RecordingSession,
) {
    use serde_json::json;

    // Filter whisper silence/blank markers. The frontend used to do this
    // before its POST; with Rust authoritative we do it here.
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
            let _ = app.emit(
                "meeting-save-failed",
                MeetingSaveFailedEvent {
                    meeting_id: session.meeting_id,
                    error: format!("HTTP {}: {}", status, body_text),
                },
            );
        }
        Err(e) => {
            tracing::error!("/save-transcript request error: {}", e);
            let _ = app.emit(
                "meeting-save-failed",
                MeetingSaveFailedEvent {
                    meeting_id: session.meeting_id,
                    error: e.to_string(),
                },
            );
        }
    }
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
        DetectionSource::Manual => "manual recording".to_string(),
    }
}

/// Phase 2b round 4: append a transcript update to the active session's
/// buffer (if any) AND emit it to the frontend. With Rust authoritative
/// for persistence, the buffer is what eventually gets POSTed to
/// `/save-transcript` from the action handler. A page refresh during
/// recording wipes only the React-side state; this server-side buffer
/// survives.
async fn record_and_emit_transcript<R: Runtime>(
    app: &AppHandle<R>,
    update: TranscriptUpdate,
) {
    {
        let session_state = app.state::<SessionState>();
        let mut slot = session_state.inner.lock().await;
        if let Some(ref mut session) = *slot {
            session.transcripts.push(update.clone());
        }
    }
    if let Err(e) = app.emit("transcript-update", update) {
        log_error!("Failed to emit transcript update: {}", e);
    }
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
    // Init tracing alongside the existing log crate so new modules emit logs.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(true)
        .try_init();
    log::set_max_level(log::LevelFilter::Info);

    // ===== Phase 2a runtime wiring =====
    let rolling_buffer = Arc::new(RollingBuffer::new());
    let (detection_tx, mut detection_rx) = mpsc::channel(64);
    let (control_tx, mut control_rx) = mpsc::channel::<ControlEvent>(64);
    let (action_tx, mut action_rx) = mpsc::channel::<RecorderAction>(64);

    // Phase 2a default: auto_record_enabled starts ON. The orchestrator will
    // sync from the backend /settings/recording endpoint shortly after launch.
    let state_machine: SharedStateMachine = Arc::new(tokio::sync::Mutex::new(
        StateMachine::new(action_tx.clone(), true),
    ));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
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

            // Sync auto_record_enabled from the backend on startup so the FSM
            // respects user preference. Best-effort — defaults to ON if we fail.
            // NOTE: tauri::async_runtime::spawn (not tokio::spawn) — the .setup
            // closure runs outside an ambient tokio runtime context.
            let control_tx_sync = control_tx.clone();
            tauri::async_runtime::spawn(async move {
                let url = "http://127.0.0.1:5167/settings/recording";
                match reqwest::get(url).await {
                    Ok(resp) => {
                        if let Ok(json) = resp.json::<serde_json::Value>().await {
                            if let Some(enabled) =
                                json.get("auto_record_enabled").and_then(|v| v.as_bool())
                            {
                                tracing::info!("Synced auto_record_enabled from backend: {}", enabled);
                                let _ = control_tx_sync
                                    .send(ControlEvent::AutoRecordToggled(enabled))
                                    .await;
                            }
                        }
                    }
                    Err(e) => tracing::warn!(
                        "Failed to fetch initial recording settings (backend may still be starting): {}",
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
            let detection_tx_proc = detection_tx.clone();
            tauri::async_runtime::spawn(async move {
                detector::process::run_process_watcher(detection_tx_proc).await;
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
            tauri::async_runtime::spawn(async move {
                detector::audio_session::run_audio_session_watcher(
                    detection_tx_audio,
                )
                .await;
                tracing::error!("Audio session watcher task EXITED");
            });

            // State machine orchestrator: pulls from detection_rx + control_rx
            let sm_orchestrator = state_machine.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::select! {
                        Some(detection_evt) = detection_rx.recv() => {
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
                            let title = if is_manual {
                                format!(
                                    "Recording {}",
                                    chrono::Utc::now().format("%Y-%m-%d %H:%M")
                                )
                            } else {
                                format!("Auto: {}", label)
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
                                save_session_to_backend(
                                    &app_for_actions,
                                    session,
                                )
                                .await;
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
            manual_stop,
            set_auto_record,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Helper function to resample audio
fn resample_audio(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate {
        return samples.to_vec();
    }
    
    let ratio = to_rate as f32 / from_rate as f32;
    let new_len = (samples.len() as f32 * ratio) as usize;
    let mut resampled = Vec::with_capacity(new_len);
    
    for i in 0..new_len {
        let src_idx = (i as f32 / ratio) as usize;
        if src_idx < samples.len() {
            resampled.push(samples[src_idx]);
        }
    }
    
    resampled
}
