'use client';

import { useState, useEffect, useContext, useCallback } from 'react';
import { Transcript, Summary, SummaryResponse } from '@/types';
import { EditableTitle } from '@/components/EditableTitle';
import { TranscriptView } from '@/components/TranscriptView';
import { RecordingControls } from '@/components/RecordingControls';
import { AISummary } from '@/components/AISummary';
import { Onboarding } from '@/components/Onboarding';
import { WelcomePanel } from '@/components/WelcomePanel';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { listen } from '@tauri-apps/api/event';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { downloadDir } from '@tauri-apps/api/path';
import { listenerCount } from 'process';
import { invoke } from '@tauri-apps/api/core';
import { useNavigation } from '@/hooks/useNavigation';
import { useRouter } from 'next/navigation';

interface TranscriptUpdate {
  text: string;
  timestamp: string;
  source: string;
}

interface ModelConfig {
  // Phase 4 Task 1A: Gemini is the bundled default. Other providers will
  // come back when Task 1B ships the user-managed Settings UI.
  provider: 'gemini' | 'groq' | 'claude';
  model: string;
  whisperModel: string;
}

type SummaryStatus = 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';

interface LlmModel {
  name: string;
  id: string;
  label?: string;
}

type RecorderState = 'Idle' | 'Potential' | 'Recording' | 'Finalizing';

// Phase 4 Task 2.5: Recording state pill is the signature brand
// moment — Recording uses Neato coral with the `rw-rec-dot` pulse +
// monospace REC label. Other states stay subtle (subtle bg, tertiary
// text) so the eye is drawn to active recording, not state churn.
const STATE_BADGE_CONFIG: Record<
  RecorderState,
  { className: string; label: string; dot: string; pulse?: boolean; mono?: boolean }
> = {
  Idle: {
    className: 'bg-rw-subtle text-rw-text-secondary',
    label: 'Ready',
    dot: 'bg-rw-text-tertiary',
  },
  Potential: {
    className: 'bg-rw-primary-bg text-rw-primary',
    label: 'Detecting…',
    dot: 'bg-rw-primary',
    pulse: true,
  },
  Recording: {
    className: 'bg-rw-coral-bg text-rw-coral-text',
    label: 'REC',
    dot: 'bg-rw-coral',
    pulse: true,
    mono: true,
  },
  Finalizing: {
    className: 'bg-rw-warning-bg text-rw-warning-text',
    label: 'Finalizing…',
    dot: 'bg-rw-warning-text',
    pulse: true,
  },
};

function StateBadge({ state }: { state: RecorderState }) {
  const config = STATE_BADGE_CONFIG[state];
  return (
    <div
      data-testid="recorder-state-badge"
      className={`flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium tracking-[0.5px] whitespace-nowrap ${config.className} ${
        config.mono ? 'font-mono' : ''
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${config.dot} ${config.pulse ? 'rw-rec-dot' : ''}`}
      />
      {config.label}
    </div>
  );
}

export default function Home() {
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [showSummary, setShowSummary] = useState(false);
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>('idle');
  const [barHeights, setBarHeights] = useState(['58%', '76%', '58%']);
  const [meetingTitle, setMeetingTitle] = useState('+ New Call');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [aiSummary, setAiSummary] = useState<Summary | null>({
    key_points: { title: "Key Points", blocks: [] },
    action_items: { title: "Action Items", blocks: [] },
    decisions: { title: "Decisions", blocks: [] },
    main_topics: { title: "Main Topics", blocks: [] }
  });
  const [summaryResponse, setSummaryResponse] = useState<SummaryResponse | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    whisperModel: 'large-v3'
  });
  const [originalTranscript, setOriginalTranscript] = useState<string>('');
  const [models, setModels] = useState<LlmModel[]>([]);
  const [error, setError] = useState<string>('');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);

  // Phase 2b round 6: recorder state and active recording metadata now
  // live in SidebarProvider so they survive any route. Read them via
  // useSidebar() — Home no longer keeps a local copy.
  const {
    setCurrentMeeting,
    recorderState,
    recordingTitle,
    // Phase 5 Task 2: welcome panel state.
    hasSeenWelcomePanel,
    dismissWelcomePanel,
  } = useSidebar();
  const isRecording = recorderState === 'Recording';

  // Phase 2b round 7 (Fix 3): bridge the canonical session title from
  // Rust into local state on every Recording entry, NOT just on title
  // string changes. If session 1 had title "Auto: Google Meet" and
  // session 2 also has "Auto: Google Meet", the previous deps-on-
  // recordingTitle effect saw no string change and didn't re-run.
  // Result: stale meetingTitle from a sidebar click or saved-meeting
  // view persisted into the new session. Keying on recorderState ===
  // 'Recording' guarantees a refresh per session boundary.
  useEffect(() => {
    if (recorderState === 'Recording' && recordingTitle) {
      setMeetingTitle(recordingTitle);
    }
  }, [recorderState, recordingTitle]);
  const handleNavigation = useNavigation('', ''); // Initialize with empty values
  const router = useRouter();

  // Phase 4 Task 1B: with the model picker removed, the only consumer
  // of `models` is this default-model effect, which keeps the
  // generate-summary POST body pointing at the first available
  // Gemini model name once /llm/models has populated.
  useEffect(() => {
    if (models.length > 0 && modelConfig.provider === 'gemini') {
      setModelConfig(prev => ({
        ...prev,
        model: models[0].name
      }));
    }
  }, [models]);

  const whisperModels = [
    'tiny',
    'tiny.en',
    'tiny-q5_1',
    'tiny.en-q5_1',
    'tiny-q8_0',
    'base',
    'base.en',
    'base-q5_1',
    'base.en-q5_1',
    'base-q8_0',
    'small',
    'small.en',
    'small.en-tdrz',
    'small-q5_1',
    'small.en-q5_1',
    'small-q8_0',
    'medium',
    'medium.en',
    'medium-q5_0',
    'medium.en-q5_0',
    'medium-q8_0',
    'large-v1',
    'large-v2',
    'large-v2-q5_0',
    'large-v2-q8_0',
    'large-v3',
    'large-v3-q5_0',
    'large-v3-turbo',
    'large-v3-turbo-q5_0',
    'large-v3-turbo-q8_0'
  ];

  useEffect(() => {
    setCurrentMeeting({ id: 'intro-call', title: meetingTitle });
  }, [meetingTitle, setCurrentMeeting]);

  useEffect(() => {
    // Phase 2a: show onboarding modal on first launch.
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch('http://localhost:5167/settings/recording');
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const data = await resp.json();
        if (cancelled) return;
        setShowOnboarding(!data.has_seen_onboarding);
      } catch (err) {
        console.warn('Could not load recording settings; skipping onboarding gate', err);
      } finally {
        if (!cancelled) setOnboardingChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Phase 2b round 7 (Fix 2): bootstrap the live transcript view from
  // Rust's session buffer ONLY when there's an active session, AND
  // re-run on every Recording / Finalizing entry — not just on Home
  // mount. The round 6 mount-only `[]` deps shape was wrong for two
  // cases: (a) refresh-during-recording: works on mount, fine; (b)
  // back-from-/meeting-details into a fresh auto-session: Home was
  // already mounted, the seed never re-ran, and stale data from a
  // prior render path persisted. Keying on recorderState fixes both.
  //
  // Rust's `get_session_transcripts` (Phase 2b round 7 Fix 1) returns
  // an empty Vec unless the FSM is Recording or Finalizing, so even
  // if this effect fires unexpectedly we won't seed stale data.
  useEffect(() => {
    if (recorderState !== 'Recording' && recorderState !== 'Finalizing') {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const buffered = await invoke<TranscriptUpdate[]>(
          'get_session_transcripts'
        );
        if (cancelled || buffered.length === 0) return;
        console.log(
          `[Phase2b r7] seeding ${buffered.length} transcripts from Rust session buffer`
        );
        let counter = 0;
        // Replace, don't append — the clear-on-Potential/Recording
        // effect below has already wiped any stale view, and Rust's
        // buffer is the authoritative set for this session.
        setTranscripts(
          buffered.map((t) => ({
            id: `${Date.now()}-${counter++}`,
            text: t.text,
            timestamp: t.timestamp,
          }))
        );
      } catch (err) {
        console.warn('[Phase2b r7] get_session_transcripts failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recorderState]);

  // Phase 2b round 7 (Fix 4): wipe transient UI state on every
  // session boundary entry. Both Potential AND Recording trigger the
  // wipe so the user gets a fresh view as soon as auto-detect fires
  // (the 12s Medium debounce window) — not 12s later when the FSM
  // actually promotes. Anything that reflects "viewing saved meeting"
  // state (transcripts loaded by sidebar navigation, stale showSummary
  // affordance) is cleared here. Idle is NOT a clear point: post-
  // session the user may want to review or generate a summary from
  // what just ended (auto sessions stay on Home rather than navigating
  // to /meeting-details).
  useEffect(() => {
    if (recorderState === 'Potential' || recorderState === 'Recording') {
      setTranscripts([]);
      setShowSummary(false);
    }
  }, [recorderState]);

  // Phase 2b round 6: small Home-local listener that just sets
  // showSummary(true) once the global meeting-saved event fires. The
  // bulk of the meeting-saved handling (sidebar update, manual-session
  // navigation) lives in SidebarProvider; only the summary button
  // affordance is Home-specific.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const fn = await listen('meeting-saved', () => {
          if (!cancelled) setShowSummary(true);
        });
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      } catch (err) {
        console.error('[Phase2b r6] Failed to subscribe to meeting-saved (Home)', err);
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (isRecording) {
      const interval = setInterval(() => {
        setBarHeights(prev => {
          const newHeights = [...prev];
          newHeights[0] = Math.random() * 20 + 10 + 'px';
          newHeights[1] = Math.random() * 20 + 10 + 'px';
          newHeights[2] = Math.random() * 20 + 10 + 'px';
          return newHeights;
        });
      }, 300);

      return () => clearInterval(interval);
    }
  }, [isRecording]);

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let transcriptCounter = 0;  // Counter for unique IDs

    const setupListener = async () => {
      try {
        console.log('Setting up transcript listener...');
        unlistenFn = await listen<TranscriptUpdate>('transcript-update', (event) => {
          console.log('Received transcript update:', event.payload);
          const newTranscript = {
            id: `${Date.now()}-${transcriptCounter++}`,  // Combine timestamp with counter for uniqueness
            text: event.payload.text,
            timestamp: event.payload.timestamp,
          };
          setTranscripts(prev => {
            // Check if this transcript already exists
            const exists = prev.some(
              t => t.text === event.payload.text && t.timestamp === event.payload.timestamp
            );
            if (exists) {
              console.log('Duplicate transcript, skipping:', newTranscript);
              return prev;
            }
            console.log('Adding new transcript:', newTranscript);
            return [...prev, newTranscript];
          });
        });
        console.log('Transcript listener setup complete');
      } catch (error) {
        console.error('Failed to setup transcript listener:', error);
        alert('Failed to setup transcript listener. Check console for details.');
      }
    };

    setupListener();
    console.log('Started listener setup');

    return () => {
      console.log('Cleaning up transcript listener...');
      if (unlistenFn) {
        unlistenFn();
        console.log('Transcript listener cleaned up');
      }
    };
  }, []);

  useEffect(() => {
    // Phase 4 Task 1A: model list comes from the Python backend now,
    // not directly from Ollama. The backend returns {provider, default,
    // models: [{name, id, label}]}. No size / modified fields — those
    // were Ollama-specific.
    const loadModels = async () => {
      try {
        const response = await fetch('http://127.0.0.1:5167/llm/models');
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        setModels(data.models || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load models');
        console.error('Error loading models:', err);
      }
    };

    loadModels();
  }, []);

  const handleRecordingStart = async () => {
    // Phase 2b round 6: title and transcript reset are both driven by
    // Rust now. The Recording-state useEffect clears transcripts;
    // the recordingTitle bridge effect mirrors Rust's session title
    // back into local meetingTitle. This handler stays so the
    // RecordingControls onRecordingStart binding remains valid.
  };

  const handleRecordingStop = async () => {
    // Phase 2b round 6: Rust drives recorderState via context. There's
    // nothing left for this callback to do — RecordingControls
    // already dispatched manual_stop, the FSM will hit Finalizing →
    // Idle, save_session_to_backend POSTs, meeting-saved fires.
    // Kept as a no-op so callers don't break.
  };

  // Phase 2b round 4 → 6: click-stop is handled entirely in Rust.
  // RecordingControls invokes manual_stop, the FSM transitions into
  // Finalizing, the post-loop flush completes, Rust POSTs the meeting
  // and emits meeting-saved (which SidebarProvider's listener picks up
  // and uses to navigate). Kept as a no-op so the existing render
  // binding `onRecordingStop={() => handleRecordingStop2(true)}` keeps
  // working.
  const handleRecordingStop2 = async (_isCallApi: boolean) => {
    // intentional no-op
  };

  const handleTranscriptUpdate = (update: any) => {
    console.log('Handling transcript update:', update);
    const newTranscript = {
      id: Date.now().toString(),
      text: update.text,
      timestamp: update.timestamp,
    };
    setTranscripts(prev => {
      // Check if this transcript already exists
      const exists = prev.some(
        t => t.text === update.text && t.timestamp === update.timestamp
      );
      if (exists) {
        return prev;
      }
      return [...prev, newTranscript];
    });
  };

  const generateAISummary = useCallback(async () => {
    setSummaryStatus('processing');
    setSummaryError(null);

    try {
      const fullTranscript = transcripts.map(t => t.text).join('\n');
      if (!fullTranscript.trim()) {
        throw new Error('No transcript text available. Please add some text first.');
      }
      
      // Store the original transcript for regeneration
      setOriginalTranscript(fullTranscript);
      
      console.log('Generating summary for transcript length:', fullTranscript.length);
      
      // Process transcript and get process_id
      console.log('Processing transcript...');
      const response = await fetch('http://localhost:5167/process-transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: fullTranscript,
          model: modelConfig.provider,
          model_name: modelConfig.model,
          chunk_size: 40000,
          overlap: 1000
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Process transcript failed:', errorData);
        setSummaryError(errorData.error || 'Failed to process transcript');
        setSummaryStatus('error');
        return;
      }

      const { process_id } = await response.json();
      console.log('Process ID:', process_id);
   

      // Poll for summary status
      const pollInterval = setInterval(async () => {
        try {
          const statusResponse = await fetch(`http://localhost:5167/get-summary/${process_id}`);
          
          if (!statusResponse.ok) {
            const errorData = await statusResponse.json();
            console.error('Get summary failed:', errorData);
            setSummaryError(errorData.error || 'Unknown error');
            setSummaryStatus('error');
            clearInterval(pollInterval);
            return;
          }

          const result = await statusResponse.json();
          console.log('Summary status:', result);

          if (result.status === 'error') {
            setSummaryError(result.error || 'Unknown error');
            setSummaryStatus('error');
            clearInterval(pollInterval);
            return;
          }

          if (result.status === 'completed' && result.data) {
            clearInterval(pollInterval);
            
            // Remove MeetingName from data before formatting
            const { MeetingName, ...summaryData } = result.data;
            
            // Update meeting title if available
            if (MeetingName) {
              setMeetingTitle(MeetingName);
            }

            // Format the summary data with consistent styling
            const formattedSummary = Object.entries(summaryData).reduce((acc: Summary, [key, section]: [string, any]) => {
              acc[key] = {
                title: section.title,
                blocks: section.blocks.map((block: any) => ({
                  ...block,
                  type: 'bullet',
                  color: 'default',
                  content: block.content.trim() // Remove trailing newlines
                }))
              };
              return acc;
            }, {} as Summary);

            setAiSummary(formattedSummary);
            setSummaryStatus('completed');
          }
        } catch (error) {
          console.error('Failed to get summary status:', error);
          if (error instanceof Error) {
            setSummaryError(`Failed to get summary status: ${error.message}`);
          } else {
            setSummaryError('Failed to get summary status: Unknown error');
          }
          setSummaryStatus('error');
          clearInterval(pollInterval);
        }
      }, 5000); // Poll every 30 seconds

      // Cleanup interval on component unmount
      return () => clearInterval(pollInterval);
      
    } catch (error) {
      console.error('Failed to generate summary:', error);
      if (error instanceof Error) {
        setSummaryError(`Failed to generate summary: ${error.message}`);
      } else {
        setSummaryError('Failed to generate summary: Unknown error');
      }
      setSummaryStatus('error');
    }
  }, [transcripts, modelConfig]);

  const handleSummary = useCallback((summary: any) => {
    setAiSummary(summary);
  }, []);

  const handleSummaryChange = (newSummary: Summary) => {
    console.log('Summary changed:', newSummary);
    setAiSummary(newSummary);
  };

  const handleTitleChange = (newTitle: string) => {
    setMeetingTitle(newTitle);
    setCurrentMeeting({ id: 'intro-call', title: newTitle });
  };

  const getSummaryStatusMessage = (status: SummaryStatus) => {
    switch (status) {
      case 'idle':
        return 'Ready to generate summary';
      case 'processing':
        return 'Processing transcript...';
      case 'summarizing':
        return 'Generating AI summary...';
      case 'regenerating':
        return 'Regenerating AI summary...';
      case 'completed':
        return 'Summary generated successfully!';
      case 'error':
        return summaryError || 'An error occurred';
      default:
        return '';
    }
  };

  const handleDownloadTranscript = async () => {
    try {
      // Create transcript object with metadata
      const transcriptData = {
        title: meetingTitle,
        timestamp: new Date().toISOString(),
        transcripts: transcripts
      };

      // Generate filename
      const sanitizedTitle = meetingTitle.replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `${sanitizedTitle}_transcript.json`;
      
      // Get download directory path
      const downloadPath = await downloadDir();
      
      // Write file to downloads directory
      await writeTextFile(`${downloadPath}/${filename}`, JSON.stringify(transcriptData, null, 2));

      console.log('Transcript saved successfully to:', `${downloadPath}/${filename}`);
      alert('Transcript downloaded successfully!');
    } catch (error) {
      console.error('Failed to save transcript:', error);
      alert('Failed to save transcript. Please try again.');
    }
  };

  const handleUploadTranscript = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      
      // Validate the uploaded file structure
      if (!data.transcripts || !Array.isArray(data.transcripts)) {
        throw new Error('Invalid transcript file format');
      }

      // Update state with uploaded data
      setMeetingTitle(data.title || 'Uploaded Transcript');
      setTranscripts(data.transcripts);
      
      // Generate summary for the uploaded transcript
      handleSummary(data.transcripts);
    } catch (error) {
      console.error('Error uploading transcript:', error);
      alert('Failed to upload transcript. Please make sure the file format is correct.');
    }
  };

  const handleRegenerateSummary = useCallback(async () => {
    if (!originalTranscript.trim()) {
      console.error('No original transcript available for regeneration');
      return;
    }

    setSummaryStatus('regenerating');
    setSummaryError(null);

    try {
      console.log('Regenerating summary with original transcript...');
      
      // Process transcript and get process_id
      console.log('Processing transcript...');
      const response = await fetch('http://localhost:5167/process-transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: originalTranscript,
          model: modelConfig.provider,
          model_name: modelConfig.model,
          chunk_size: 40000,
          overlap: 1000
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Process transcript failed:', errorData);
        throw new Error(errorData.error || 'Failed to process transcript');
      }

      const { process_id } = await response.json();
      console.log('Process ID:', process_id);

      // Poll for summary status
      const pollInterval = setInterval(async () => {
        try {
          const statusResponse = await fetch(`http://localhost:5167/get-summary/${process_id}`);
          
          if (!statusResponse.ok) {
            const errorData = await statusResponse.json();
            console.error('Get summary failed:', errorData);
            throw new Error(errorData.error || 'Failed to get summary status');
          }

          const result = await statusResponse.json();
          console.log('Summary status:', result);

          if (result.status === 'error') {
            setSummaryError(result.error || 'Unknown error');
            setSummaryStatus('error');
            clearInterval(pollInterval);
            return;
          }

          if (result.status === 'completed' && result.data) {
            clearInterval(pollInterval);
            
            // Remove MeetingName from data before formatting
            const { MeetingName, ...summaryData } = result.data;
            
            // Update meeting title if available
            if (MeetingName) {
              setMeetingTitle(MeetingName);
            }

            // Format the summary data with consistent styling
            const formattedSummary = Object.entries(summaryData).reduce((acc: Summary, [key, section]: [string, any]) => {
              acc[key] = {
                title: section.title,
                blocks: section.blocks.map((block: any) => ({
                  ...block,
                  type: 'bullet',
                  color: 'default',
                  content: block.content.trim()
                }))
              };
              return acc;
            }, {} as Summary);

            setAiSummary(formattedSummary);
            setSummaryStatus('completed');
          } else if (result.status === 'error') {
            clearInterval(pollInterval);
            throw new Error(result.error || 'Failed to generate summary');
          }
        } catch (error) {
          clearInterval(pollInterval);
          console.error('Failed to get summary status:', error);
          if (error instanceof Error) {
            setSummaryError(error.message);
          } else {
            setSummaryError('An unexpected error occurred');
          }
          setSummaryStatus('error');
          setAiSummary(null);
        }
      }, 10000);

      return () => clearInterval(pollInterval);
    } catch (error) {
      console.error('Failed to regenerate summary:', error);
      if (error instanceof Error) {
        setSummaryError(error.message);
      } else {
        setSummaryError('An unexpected error occurred');
      }
      setSummaryStatus('error');
      setAiSummary(null);
    }
  }, [originalTranscript, modelConfig]);

  const handleCopyTranscript = useCallback(() => {
    const fullTranscript = transcripts
      .map(t => `${t.timestamp}: ${t.text}`)
      .join('\n');
    navigator.clipboard.writeText(fullTranscript);
  }, [transcripts]);

  const handleGenerateSummary = useCallback(async () => {
    if (!transcripts.length) {
      console.log('No transcripts available for summary');
      return;
    }
    
    try {
      await generateAISummary();
    } catch (error) {
      console.error('Failed to generate summary:', error);
      if (error instanceof Error) {
        setSummaryError(error.message);
      } else {
        setSummaryError('Failed to generate summary: Unknown error');
      }
    }
  }, [transcripts, generateAISummary]);

  const isSummaryLoading = summaryStatus === 'processing' || summaryStatus === 'summarizing' || summaryStatus === 'regenerating';

  return (
    <div className="flex flex-col h-screen bg-gray-50 relative">
      {showOnboarding && (
        <Onboarding onComplete={() => setShowOnboarding(false)} />
      )}
      {/* Phase 5 Task 2: in-pane welcome panel for first-launch users.
          Renders OVER the recording UI, dismisses to reveal it.
          Distinct from the Onboarding consent modal which gates the
          auto-record permission step. */}
      {hasSeenWelcomePanel === false && !showOnboarding && (
        <WelcomePanel onDismiss={dismissWelcomePanel} />
      )}
      <div className="flex flex-1 overflow-hidden">
        {/* Left side - Transcript */}
        <div className="w-1/3 min-w-[300px] border-r border-gray-200 bg-white flex flex-col relative">
          {/* Title area */}
          <div className="p-4 border-b border-gray-200">
            <div className="flex flex-col space-y-3">
              <div className="flex items-center justify-between gap-3 min-w-0">
                <div className="min-w-0 flex-1 overflow-hidden">
                  <EditableTitle
                    title={meetingTitle}
                    isEditing={isEditingTitle}
                    onStartEditing={() => setIsEditingTitle(true)}
                    onFinishEditing={() => setIsEditingTitle(false)}
                    onChange={handleTitleChange}
                  />
                </div>
                <StateBadge state={recorderState} />
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={handleCopyTranscript}
                  disabled={transcripts.length === 0}
                  className={`px-3 py-2 border rounded-md transition-all duration-200 inline-flex items-center gap-2 shadow-sm ${
                    transcripts.length === 0
                      ? 'bg-gray-50 border-gray-200 text-gray-400 cursor-not-allowed'
                      : 'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100 hover:border-blue-300 active:bg-blue-200'
                  }`}
                  title={transcripts.length === 0 ? 'No transcript available' : 'Copy Transcript'}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" fill="none">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V7.5l-3.75-3.612z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 3v3.75a.75.75 0 0 0 .75.75H18" />
                  </svg>
                  <span className="text-sm">Copy Transcript</span>
                </button>
                {showSummary && !isRecording && (
                  <>
                    <button
                      onClick={handleGenerateSummary}
                      disabled={summaryStatus === 'processing'}
                      className={`px-3 py-2 border rounded-md transition-all duration-200 inline-flex items-center gap-2 shadow-sm ${
                        summaryStatus === 'processing'
                          ? 'bg-yellow-50 border-yellow-200 text-yellow-700'
                          : transcripts.length === 0
                          ? 'bg-gray-50 border-gray-200 text-gray-400 cursor-not-allowed'
                          : 'bg-green-50 border-green-200 text-green-700 hover:bg-green-100 hover:border-green-300 active:bg-green-200'
                      }`}
                      title={
                        summaryStatus === 'processing'
                          ? 'Generating summary...'
                          : transcripts.length === 0
                          ? 'No transcript available'
                          : 'Generate AI Summary'
                      }
                    >
                      {summaryStatus === 'processing' ? (
                        <>
                          <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          <span className="text-sm">Processing...</span>
                        </>
                      ) : (
                        <>
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          <span className="text-sm">Generate Note</span>
                        </>
                      )}
                    </button>
                    {/* Phase 4 Task 1B: the homepage's per-meeting
                        gear icon used to open the model picker. With
                        Gemini-only single-tenant config, app-level
                        settings live on the dedicated /settings page
                        (sidebar bottom-left), and the per-meeting
                        custom prompt is exposed on the meeting-details
                        view. The button is removed here to avoid
                        ambiguity. */}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Transcript content */}
          <div className="flex-1 overflow-y-auto pb-32">
            <TranscriptView transcripts={transcripts} />
          </div>

          {/* Recording controls */}
          <div className="absolute bottom-16 left-1/2 transform -translate-x-1/2 z-10 flex flex-col items-center space-y-2">
            <div className="bg-white rounded-full shadow-lg flex items-center">
              <RecordingControls
                isRecording={isRecording}
                onRecordingStop={() => handleRecordingStop2(true)}
                onRecordingStart={handleRecordingStart}
                onTranscriptReceived={handleTranscriptUpdate}
                barHeights={barHeights}
                recorderState={recorderState}
              />
            </div>
          </div>

          {/* Phase 4 Task 1B: the per-user model picker is gone.
              Model/provider config is single-tenant Gemini for v1
              (bundled key); app-level settings live on /settings. */}
        </div>

        {/* Right side - AI Summary */}
        <div className="flex-1 overflow-y-auto bg-white">
          {isSummaryLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mb-4"></div>
                <p className="text-gray-600">Generating AI Summary...</p>
              </div>
            </div>
          ) : showSummary && (
            <div className="max-w-4xl mx-auto p-6">
              {summaryResponse && (
                <div className="fixed bottom-0 left-0 right-0 bg-white shadow-lg p-4 max-h-1/3 overflow-y-auto">
                  <h3 className="text-lg font-semibold mb-2">Meeting Summary</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white p-4 rounded-lg shadow-sm">
                      <h4 className="font-medium mb-1">Key Points</h4>
                      <ul className="list-disc pl-4">
                        {summaryResponse.summary.key_points.blocks.map((block, i) => (
                          <li key={i} className="text-sm">{block.content}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="bg-white p-4 rounded-lg shadow-sm mt-4">
                      <h4 className="font-medium mb-1">Action Items</h4>
                      <ul className="list-disc pl-4">
                        {summaryResponse.summary.action_items.blocks.map((block, i) => (
                          <li key={i} className="text-sm">{block.content}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="bg-white p-4 rounded-lg shadow-sm mt-4">
                      <h4 className="font-medium mb-1">Decisions</h4>
                      <ul className="list-disc pl-4">
                        {summaryResponse.summary.decisions.blocks.map((block, i) => (
                          <li key={i} className="text-sm">{block.content}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="bg-white p-4 rounded-lg shadow-sm mt-4">
                      <h4 className="font-medium mb-1">Main Topics</h4>
                      <ul className="list-disc pl-4">
                        {summaryResponse.summary.main_topics.blocks.map((block, i) => (
                          <li key={i} className="text-sm">{block.content}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  {summaryResponse.raw_summary ? (
                    <div className="mt-4">
                      <h4 className="font-medium mb-1">Full Summary</h4>
                      <p className="text-sm whitespace-pre-wrap">{summaryResponse.raw_summary}</p>
                    </div>
                  ) : null}
                </div>
              )}
              <div className="flex-1 overflow-y-auto p-4">
                <AISummary 
                  summary={aiSummary} 
                  status={summaryStatus} 
                  error={summaryError}
                  onSummaryChange={(newSummary) => setAiSummary(newSummary)}
                  onRegenerateSummary={handleRegenerateSummary}
                />
              </div>
              {summaryStatus !== 'idle' && (
                <div className={`mt-4 p-4 rounded-lg ${
                  summaryStatus === 'error' ? 'bg-red-100 text-red-700' :
                  summaryStatus === 'completed' ? 'bg-green-100 text-green-700' :
                  'bg-blue-100 text-blue-700'
                }`}>
                  <p className="text-sm font-medium">{getSummaryStatusMessage(summaryStatus)}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
