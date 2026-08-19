"use client";
import { useState, useEffect, useCallback, useRef } from 'react';
import { Transcript, Summary, SummaryResponse } from '@/types';
import { EditableTitle } from '@/components/EditableTitle';
import { TranscriptView } from '@/components/TranscriptView';
import { AISummary } from '@/components/AISummary';
import { CurrentMeeting, useSidebar } from '@/components/Sidebar/SidebarProvider';
import { CustomSummaryPromptModal } from '@/components/CustomSummaryPromptModal';
import { MeetingAskPanel } from '@/components/Ask/MeetingAskPanel';
import { authFetch } from '@/lib/authFetch';

// Phase 4 Task 1A: model picker is gone (Gemini-only for v1) but the
// rest of the page still passes a ModelConfig around for the existing
// /process-transcript request shape. Keep the type local to avoid
// re-introducing a settings modal.
type ModelConfig = {
  provider: 'gemini';
  model: string;
  whisperModel: string;
};

type SummaryStatus = 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';

// Phase 4 Task 2.5: small status pill showing when this meeting was
// recorded. Teal for today/yesterday (recent), subtle grey for older.
// Pure presentation — `created_at` is parsed defensively (ISO with or
// without Z, the bare-SQLite shape coming from Phase 3 Task 5 should
// already be normalised by the backend serializer).
function RecordedPill({ createdAt }: { createdAt?: string | null }) {
  if (!createdAt) return null;
  const ts = new Date(
    createdAt.includes('T') || createdAt.includes('Z') || /\+\d\d:?\d\d$/.test(createdAt)
      ? createdAt
      : `${createdAt}Z`,
  );
  if (Number.isNaN(ts.getTime())) return null;

  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.floor((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  const time = ts.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = ts.toLocaleDateString([], { month: 'short', day: 'numeric' });

  let label: string;
  let recent = false;
  if (dayDiff <= 0) {
    label = `Recorded today, ${time}`;
    recent = true;
  } else if (dayDiff === 1) {
    label = `Recorded yesterday, ${time}`;
    recent = true;
  } else {
    label = `Recorded ${date}`;
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium tracking-[0.3px] w-fit ${
        recent
          ? 'bg-rw-primary-bg text-rw-success-text'
          : 'bg-rw-subtle text-rw-text-secondary'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          recent ? 'bg-rw-primary' : 'bg-rw-text-tertiary'
        }`}
      />
      {label}
    </span>
  );
}

export default function PageContent({ meeting, summaryData }: { meeting: any, summaryData: Summary }) {
  const [transcripts, setTranscripts] = useState<Transcript[]>(meeting.transcripts);
  const [speakerMap, setSpeakerMap] = useState<Record<string, string>>(meeting.speaker_map ?? {});
  const [showSummary, setShowSummary] = useState(false);
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>('idle');
  const [meetingTitle, setMeetingTitle] = useState(meeting.title || '+ New Call');
  // Phase 3 Task 8: snapshot of the latest title so the summary-poll
  // closures can read the *current* value (including any user rename
  // that happened during the 5-10s the summary was processing) when
  // deciding whether to apply the LLM's MeetingName. The backend has
  // its own Auto:-only guard; this frontend ref prevents the optimistic
  // local update from briefly overwriting a user rename.
  const meetingTitleRef = useRef(meetingTitle);
  useEffect(() => {
    meetingTitleRef.current = meetingTitle;
  }, [meetingTitle]);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [aiSummary, setAiSummary] = useState<Summary | null>(summaryData);
  // Phase 3 Task 7.5: tracks whether the user has touched the summary
  // since it was last loaded/regenerated. Used to gate Regenerate behind
  // a confirm so we never silently throw away hand edits. In-session
  // only — edits aren't persisted to the backend yet, so this resets on
  // page reload along with the edits themselves.
  const [summaryModified, setSummaryModified] = useState(false);
  const [summaryResponse, setSummaryResponse] = useState<SummaryResponse | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    whisperModel: 'large-v3'
  });
  // Phase 4 Task 1B: gear icon now opens the per-meeting custom
  // summary prompt modal. The previous ModelSettingsModal (a Gemini-
  // only config screen) has been deleted.
  const [showCustomPrompt, setShowCustomPrompt] = useState(false);
  const [originalTranscript, setOriginalTranscript] = useState<string>('');
  const [error, setError] = useState<string>('');
  // Selected-template caption shown under the Generate note button.
  // Names which prompt template will be used the next time the user
  // generates / regenerates the summary. Refreshed on mount and after
  // the gear modal closes (since that's the only way it changes from
  // this view).
  const [selectedTemplateLabel, setSelectedTemplateLabel] = useState<string>(
    'Default summary',
  );
  const {
    setCurrentMeeting,
    setMeetings,
    // Phase 3 Task 7: organization state + actions.
    folders,
    tags: allTags,
    setMeetingFolder,
    addMeetingTag,
    removeMeetingTag,
    // Phase 3 Task 9: saved prompt cache for the move-to-folder
    // confirmation dialog (Apply / Skip).
    savedPrompts,
  } = useSidebar();
  // Phase 3 Task 9: state for the move-to-folder confirmation dialog.
  // Set when the user picks a target folder whose default differs
  // from the source's; cleared by Apply / Skip / Cancel. The move is
  // ALWAYS performed before this state is set — this dialog only
  // governs whether the new folder's prompt is also applied.
  const [pendingMovePrompt, setPendingMovePrompt] = useState<{
    folderName: string;
    promptId: number;
    promptName: string;
    promptText: string;
    hadCustomPrompt: boolean;
  } | null>(null);
  const [applyingPrompt, setApplyingPrompt] = useState(false);
  // Phase 3 Task 7: local mirror of this meeting's folder + tags.
  // Seeded from the meeting prop on mount; mutated by the dropdown
  // and tag-chip handlers, which also push to the backend via the
  // SidebarContext methods (which keep the global meetings array in
  // sync so the sidebar re-renders).
  const [folderId, setFolderId] = useState<string | null>(meeting.folder_id ?? null);
  const [meetingTags, setMeetingTags] = useState<{ id: string; name: string }[]>(
    Array.isArray(meeting.tags) ? meeting.tags : []
  );
  const [addingTag, setAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    const fetchModelConfig = async () => {
      try {
        const response = await fetch('http://localhost:5167/get-model-config');
        const data = await response.json();
        if (data.provider !== null) {
          setModelConfig(data);
        }
      } catch (error) {
        console.error('Failed to fetch model config:', error);
      }
    };

    fetchModelConfig();
  }, []);

  useEffect(() => {
    console.log('Model config:', modelConfig);
  }, [modelConfig]);

  // Selected-template caption: derive from the meeting's saved
  // custom prompt + source. Re-runs when the gear modal closes
  // (showCustomPrompt flips false) so the label reflects edits made
  // there. savedPrompts is in the dep list because we match the
  // prompt text against the library to surface the template name
  // for "manual" picks; if the library hasn't loaded yet the label
  // defaults to "Custom prompt".
  useEffect(() => {
    let cancelled = false;
    if (showCustomPrompt) return; // skip while the modal is open
    (async () => {
      try {
        const resp = await fetch(
          `http://localhost:5167/meetings/${meeting.id}/custom-prompt`,
        );
        if (!resp.ok) return;
        const data = await resp.json();
        if (cancelled) return;
        const promptText = (data?.prompt ?? '').trim();
        const source: 'manual' | 'folder_default' | null = data?.source ?? null;
        if (!promptText) {
          setSelectedTemplateLabel('Default summary');
          return;
        }
        if (source === 'folder_default' && data?.folder_default_prompt_name) {
          setSelectedTemplateLabel(
            `${data.folder_default_prompt_name} (folder default)`,
          );
          return;
        }
        // 'manual' or unknown source: try to recover the template
        // name by matching the saved prompt text verbatim against
        // the library. If no match, the user typed it freehand.
        const match = savedPrompts.find(
          (p) => (p.prompt_text ?? '').trim() === promptText,
        );
        setSelectedTemplateLabel(match ? match.name : 'Custom prompt');
      } catch (err) {
        // Non-fatal — keep whatever label was last set.
        console.warn('selected-template fetch failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meeting.id, showCustomPrompt, savedPrompts]);

  const generateAISummary = useCallback(async () => {
    setSummaryStatus('processing');
    setSummaryError(null);

    try {
      const fullTranscript = transcripts?.map(t => t.text).join('\n');
      if (!fullTranscript.trim()) {
        throw new Error('No transcript text available. Please add some text first.');
      }

      setOriginalTranscript(fullTranscript);
      
      console.log('Generating summary for transcript length:', fullTranscript.length);
      
      // Process transcript and get process_id
      console.log('Processing transcript...');
      const response = await authFetch('http://localhost:5167/process-transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: fullTranscript,
          model: modelConfig.provider,
          model_name: modelConfig.model,
          meeting_id: meeting.id,
          chunk_size: 40000,
          overlap: 1000
        }),
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
            // Defensive: check if all sections are empty
            const summarySections = Object.entries(result.data).filter(([key]) => key !== 'MeetingName');
            const allEmpty = summarySections.every(([, section]) => !(section as any).blocks || (section as any).blocks.length === 0);
            if (allEmpty) {
              setSummaryError('Summary generation failed. Please check your model/API key settings.');
              setSummaryStatus('error');
              clearInterval(pollInterval);
              return;
            }
            clearInterval(pollInterval);

            // Remove MeetingName from data before formatting
            const { MeetingName: _rawMeetingName, ...summaryData } = result.data;
            // Defensive: cloud/older summaries may carry MeetingName as a
            // { title, blocks } object rather than a string. Coerce so the
            // title logic below never throws ("toLowerCase is not a function").
            const MeetingName: string =
              typeof _rawMeetingName === 'string'
                ? _rawMeetingName
                : (((_rawMeetingName as any)?.blocks?.[0]?.content as string) ?? '');

            // Phase 3 Task 8: only auto-apply the LLM-generated title
            // when the meeting still has its `Auto: <App> · <date>`
            // placeholder. If the user has manually renamed (either at
            // load time or during the 5-10s summary window), preserve
            // their name. The backend enforces the same guard against
            // the DB; this is the matching frontend gate so the user
            // doesn't see their custom name flash to the LLM's pick.
            // "Untitled meeting" is the LLM's documented "no clear
            // topic" sentinel — skip it explicitly.
            const shouldAutoRename =
              MeetingName &&
              MeetingName.toLowerCase() !== 'untitled meeting' &&
              (meetingTitleRef.current.startsWith('Auto: ') ||
                meetingTitleRef.current.startsWith('Recording '));
            if (shouldAutoRename) {
              setMeetingTitle(MeetingName);
              setMeetings((prev: CurrentMeeting[]) => prev.map(m => m.id === meeting.id ? { ...m, title: MeetingName } : m));
              setCurrentMeeting({ id: meeting.id, title: MeetingName });
            }
            
            // Format the summary data with consistent styling
            const formattedSummary = Object.entries(summaryData).reduce((acc: Summary, [key, section]: [string, any]) => {
              // Guard: the LLM occasionally returns a section without a blocks
              // array (or a bare value) — skip anything that isn't a proper
              // {title, blocks} section so section.blocks.map can't crash.
              if (!section || typeof section !== 'object' || !Array.isArray(section.blocks)) {
                return acc;
              }
              acc[key] = {
                title: typeof section.title === 'string' ? section.title : key,
                blocks: section.blocks.map((block: any) => ({
                  ...block,
                  type: 'bullet',
                  color: 'default',
                  content: (typeof block?.content === 'string' ? block.content : String(block?.content ?? '')).trim() // Remove trailing newlines
                }))
              };
              return acc;
            }, {} as Summary);

            setAiSummary(formattedSummary);
            // Fresh LLM output replaces any prior local edits.
            setSummaryModified(false);
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
      }, 5000); // Poll every 5 seconds

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
  }, [transcripts, modelConfig, meeting.id]);

  const handleSummary = useCallback((summary: any) => {
    setAiSummary(summary);
  }, []);

  const handleSummaryChange = (newSummary: Summary) => {
    setAiSummary(newSummary);
  };

  const handleTitleChange = (newTitle: string) => {
    setMeetingTitle(newTitle);
  };

  const getSummaryStatusMessage = (status: SummaryStatus) => {
    switch (status) {
      case 'processing':
        return 'Processing transcript...';
      case 'summarizing':
        return 'Generating summary...';
      case 'regenerating':
        return 'Regenerating summary...';
      case 'completed':
        return 'Summary completed';
      case 'error':
        return 'Error generating summary';
      default:
        return '';
    }
  };

  const handleRegenerateSummary = useCallback(async () => {
    if (!originalTranscript.trim()) {
      console.error('No original transcript available for regeneration');
      return;
    }

    // Phase 3 Task 7.5: if the user has hand-edited the summary in this
    // session, regenerating will overwrite their work. Confirm before
    // we burn the LLM call and discard their edits.
    if (summaryModified) {
      const ok = window.confirm(
        'Regenerate the summary? Your edits to the current summary will be lost.'
      );
      if (!ok) return;
    }

    setSummaryStatus('regenerating');
    setSummaryError(null);

    try {
      console.log('Regenerating summary with original transcript...');
      
      // Process transcript and get process_id
      console.log('Processing transcript...');
      const response = await authFetch('http://localhost:5167/process-transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: originalTranscript,
          model: modelConfig.provider,
          model_name: modelConfig.model,
          meeting_id: meeting.id,
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
            const { MeetingName: _rawMeetingName, ...summaryData } = result.data;
            // Defensive: cloud/older summaries may carry MeetingName as a
            // { title, blocks } object rather than a string. Coerce so the
            // title logic below never throws ("toLowerCase is not a function").
            const MeetingName: string =
              typeof _rawMeetingName === 'string'
                ? _rawMeetingName
                : (((_rawMeetingName as any)?.blocks?.[0]?.content as string) ?? '');
            
            // Phase 3 Task 8: only auto-apply the LLM-generated title
            // when the meeting still has its `Auto: <App> · <date>`
            // placeholder. If the user has manually renamed (either at
            // load time or during the 5-10s summary window), preserve
            // their name. The backend enforces the same guard against
            // the DB; this is the matching frontend gate so the user
            // doesn't see their custom name flash to the LLM's pick.
            // "Untitled meeting" is the LLM's documented "no clear
            // topic" sentinel — skip it explicitly.
            const shouldAutoRename =
              MeetingName &&
              MeetingName.toLowerCase() !== 'untitled meeting' &&
              (meetingTitleRef.current.startsWith('Auto: ') ||
                meetingTitleRef.current.startsWith('Recording '));
            if (shouldAutoRename) {
              setMeetingTitle(MeetingName);
              setMeetings((prev: CurrentMeeting[]) => prev.map(m => m.id === meeting.id ? { ...m, title: MeetingName } : m));
              setCurrentMeeting({ id: meeting.id, title: MeetingName });
            }

            // Format the summary data with consistent styling
            const formattedSummary = Object.entries(summaryData).reduce((acc: Summary, [key, section]: [string, any]) => {
              // Guard: the LLM occasionally returns a section without a blocks
              // array (or a bare value) — skip anything that isn't a proper
              // {title, blocks} section so section.blocks.map can't crash.
              if (!section || typeof section !== 'object' || !Array.isArray(section.blocks)) {
                return acc;
              }
              acc[key] = {
                title: typeof section.title === 'string' ? section.title : key,
                blocks: section.blocks.map((block: any) => ({
                  ...block,
                  type: 'bullet',
                  color: 'default',
                  content: (typeof block?.content === 'string' ? block.content : String(block?.content ?? '')).trim()
                }))
              };
              return acc;
            }, {} as Summary);

            setAiSummary(formattedSummary);
            // Regenerate replaces any prior edits; clear the flag.
            setSummaryModified(false);
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
  }, [originalTranscript, modelConfig, meeting.id, summaryModified]);

  const handleCopyTranscript = useCallback(() => {
    const header = `# Transcript of the Meeting: ${meeting.id} - ${meetingTitle??meeting.title}\n\n`;
    const date = `## Date: ${new Date(meeting.created_at).toLocaleDateString()}\n\n`;
    // Phase 6 Task 3: drop the segment-level timestamp prefix. New
    // recordings already carry per-turn "[MM:SS]" markers inside
    // the text from Gemini; old recordings have meaningless
    // chunk-relative timestamps that reset to 0 every chunk. Joining
    // the text bodies verbatim is clean for both cases.
    const fullTranscript = transcripts.map((t) => t.text).join('\n');
    navigator.clipboard.writeText(header + date + fullTranscript);
  }, [transcripts, meeting, meetingTitle]);

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

  const handleSaveMeetingTitle = async () => {
    // Phase 3 Task 6: skip the API call when the title hasn't actually
    // changed. EditableTitle's Escape / empty-Enter paths now revert
    // local state to the snapshot before this fires, so an unchanged
    // value here means either (a) the user pressed Escape, (b) the
    // user pressed Enter without typing, or (c) the trimmed value
    // equals the original. None of those need a round-trip.
    const trimmed = meetingTitle.trim();
    if (!trimmed || trimmed === meeting.title) {
      return;
    }

    try {
      const payload = {
        meeting_id: meeting.id,
        title: trimmed,
      };
      console.log('Saving meeting title with payload:', payload);

      const response = await fetch('http://localhost:5167/save-meeting-title', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        // Phase 3 Task 6: backend now returns 422 for validation
        // failures and 404 for missing meeting. Surface a useful
        // message to the user via setError instead of just logging.
        let detail = `HTTP ${response.status}`;
        try {
          const errorData = await response.json();
          detail = errorData.detail || errorData.error || detail;
        } catch {
          /* response body wasn't JSON */
        }
        console.error('Save meeting title failed:', response.status, detail);
        throw new Error(`Failed to save meeting title: ${detail}`);
      }

      const responseData = await response.json();
      console.log('Save meeting title success:', responseData);

      setMeetings((prev: CurrentMeeting[]) =>
        prev.map((m) =>
          m.id === meeting.id ? { ...m, title: trimmed } : m
        )
      );
      setCurrentMeeting({ id: meeting.id, title: trimmed });
    } catch (error) {
      console.error('Failed to save meeting title:', error);
      // Revert local state so the UI matches the persisted value.
      setMeetingTitle(meeting.title);
      if (error instanceof Error) {
        setError(error.message);
      } else {
        setError('Failed to save meeting title: Unknown error');
      }
    }
  };

  const isSummaryLoading = summaryStatus === 'processing' || summaryStatus === 'summarizing' || summaryStatus === 'regenerating';

  return (
    <div className="flex flex-col h-screen bg-rw-bg-app">
      <div className="flex flex-1 overflow-hidden">
        {/* Phase 4 Task 2: left pane = card. Margin around it puts the
            app bg between cards instead of bare panel-vs-panel borders. */}
        <div className="w-1/3 min-w-[300px] m-4 mr-2 bg-rw-card border border-rw-border rounded-rw-lg flex flex-col relative overflow-hidden">
          {/* Header card content (was: Title area) */}
          <div className="p-5 border-b border-rw-border">
            <div className="flex flex-col space-y-3">
              <div className="flex items-center">
                <EditableTitle
                  title={meetingTitle}
                  isEditing={isEditingTitle}
                  onStartEditing={() => setIsEditingTitle(true)}
                  onFinishEditing={() => {
                    setIsEditingTitle(false);
                    handleSaveMeetingTitle();
                  }}
                  onChange={handleTitleChange}
                />
              </div>
              {/* Phase 4 Task 2.5: status pill for saved meetings. Teal
                  for "Recorded today, hh:mm" and "Recorded yesterday, …",
                  subtle for older recordings. The signature coral REC
                  pill lives on the home page (StateBadge); this pane
                  only sees historical state. */}
              <RecordedPill createdAt={meeting.created_at} />
              {/* Phase 3 Task 7: folder selector. "Uncategorized" is the
                  default option and represents folder_id=null. Changing
                  the dropdown calls the SidebarContext method which
                  pushes to backend AND updates the global meetings
                  state so the sidebar moves the meeting to the new
                  folder without a refetch. */}
              <div className="flex items-center gap-2 text-[13px]">
                <span className="text-rw-text-secondary">Folder</span>
                <select
                  value={folderId ?? ''}
                  onChange={async (e) => {
                    const newFolderId = e.target.value || null;
                    // Phase 3 Task 9: capture old/new folder defaults
                    // BEFORE the move. The move always happens; the
                    // dialog (if any) only governs whether the new
                    // folder's default prompt is then applied.
                    const oldFolder = folderId
                      ? folders.find((f) => f.id === folderId)
                      : null;
                    const newFolder = newFolderId
                      ? folders.find((f) => f.id === newFolderId)
                      : null;
                    const oldDefault = oldFolder?.default_prompt_id ?? null;
                    const newDefault = newFolder?.default_prompt_id ?? null;

                    const ok = await setMeetingFolder(meeting.id, newFolderId);
                    if (!ok) return;
                    setFolderId(newFolderId);

                    // Show the prompt-confirmation dialog when the new
                    // folder has a default that differs from the old
                    // folder's. Same default → silent move. No new
                    // default → silent move. Manual prompt currently
                    // on the meeting → still ask, but with replace
                    // wording so the user knows what they'd overwrite.
                    if (newDefault !== null && newDefault !== oldDefault && newFolder) {
                      const sp = savedPrompts.find((p) => p.id === newDefault);
                      if (sp) {
                        // Cheap probe: does this meeting already have
                        // a manual prompt set? Read the current
                        // saved-prompt source so the dialog wording is
                        // accurate. The GET endpoint exists for the
                        // gear modal's load path.
                        let hadCustomPrompt = false;
                        try {
                          const probe = await fetch(
                            `http://localhost:5167/meetings/${meeting.id}/custom-prompt`,
                          );
                          if (probe.ok) {
                            const data = await probe.json();
                            hadCustomPrompt =
                              data?.source === 'manual' &&
                              typeof data?.prompt === 'string' &&
                              data.prompt.trim().length > 0;
                          }
                        } catch {
                          // Probe failure isn't fatal — fall back to
                          // the additive wording.
                        }
                        setPendingMovePrompt({
                          folderName: newFolder.name,
                          promptId: sp.id,
                          promptName: sp.name,
                          promptText: sp.prompt_text,
                          hadCustomPrompt,
                        });
                      }
                    }
                  }}
                  className="px-2.5 py-1 border border-rw-border rounded-rw-md bg-rw-card text-rw-text-primary hover:border-rw-border-strong focus:outline-none focus:ring-2 focus:ring-rw-primary-bg focus:border-rw-primary"
                >
                  <option value="">Uncategorized</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
              {/* Phase 3 Task 7: tag chips + add-tag input. Each chip
                  has an X to detach (the tag itself stays globally —
                  only the meeting<->tag association is removed). The
                  add-tag input does autocomplete-on-Enter against the
                  global tag list (case-insensitive); typing a new
                  name creates the tag and attaches it in one round-
                  trip via the create-or-find logic in POST
                  /meetings/:id/tags. */}
              <div className="flex flex-wrap gap-1.5 items-center text-sm">
                {meetingTags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-rw-sm bg-rw-primary-bg text-rw-info-text"
                    title={tag.name}
                  >
                    <span className="text-[11px] font-medium">#{tag.name}</span>
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await removeMeetingTag(meeting.id, tag.id);
                        if (ok) {
                          setMeetingTags((prev) =>
                            prev.filter((t) => t.id !== tag.id)
                          );
                        }
                      }}
                      className="text-rw-info-text/60 hover:text-rw-info-text leading-none"
                      title="Remove tag from this meeting"
                    >
                      ×
                    </button>
                  </span>
                ))}
                {addingTag ? (
                  <input
                    autoFocus
                    list="tag-autocomplete"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onBlur={() => {
                      // Cancel on blur with empty input. If non-empty,
                      // commit on blur same as Enter.
                      const name = tagInput.trim();
                      if (!name) {
                        setAddingTag(false);
                        setTagInput('');
                        return;
                      }
                      // (commit handled by Enter handler; blur path
                      // mirrors that for a user who clicks away)
                      void (async () => {
                        const existing = allTags.find(
                          (t) =>
                            t.name.toLowerCase() === name.toLowerCase()
                        );
                        const updated = await addMeetingTag(meeting.id, {
                          id: existing?.id,
                          name: existing ? undefined : name,
                        });
                        if (updated) setMeetingTags(updated);
                        setAddingTag(false);
                        setTagInput('');
                      })();
                    }}
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const name = tagInput.trim();
                        if (!name) {
                          setAddingTag(false);
                          setTagInput('');
                          return;
                        }
                        const existing = allTags.find(
                          (t) =>
                            t.name.toLowerCase() === name.toLowerCase()
                        );
                        const updated = await addMeetingTag(meeting.id, {
                          id: existing?.id,
                          name: existing ? undefined : name,
                        });
                        if (updated) setMeetingTags(updated);
                        setAddingTag(false);
                        setTagInput('');
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setAddingTag(false);
                        setTagInput('');
                      }
                    }}
                    placeholder="tag name"
                    maxLength={50}
                    className="px-2 py-0.5 text-xs border-b border-blue-400 outline-none bg-transparent w-32"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setAddingTag(true);
                      setTagInput('');
                    }}
                    className="px-2 py-0.5 rounded-rw-sm text-[11px] text-rw-text-tertiary hover:bg-rw-hover border border-dashed border-rw-border-strong"
                  >
                    + Add tag
                  </button>
                )}
                {/* Datalist provides browser-native autocomplete for the
                    tag-name input above. Filters to tags not already on
                    this meeting so the user doesn't see duplicate
                    suggestions. */}
                <datalist id="tag-autocomplete">
                  {allTags
                    .filter(
                      (t) => !meetingTags.some((mt) => mt.id === t.id)
                    )
                    .map((t) => (
                      <option key={t.id} value={t.name} />
                    ))}
                </datalist>
              </div>
              {/* Phase 4 Task 2: action cluster. Generate Note is the
                  primary blue (most prominent action on the page);
                  Copy Transcript and the gear are secondary outlined. */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleCopyTranscript}
                  disabled={transcripts?.length === 0}
                  className={`px-3 py-2 border rounded-rw-md inline-flex items-center gap-2 text-[13px] transition-colors ${
                    transcripts?.length === 0
                      ? 'bg-rw-subtle border-rw-border text-rw-text-tertiary cursor-not-allowed'
                      : 'bg-rw-card border-rw-border text-rw-text-primary hover:bg-rw-hover hover:border-rw-border-strong'
                  }`}
                  title={transcripts?.length === 0 ? 'No transcript available' : 'Copy Transcript'}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" fill="none">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V7.5l-3.75-3.612z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 3v3.75a.75.75 0 0 0 .75.75H18" />
                  </svg>
                  <span>Copy transcript</span>
                </button>
                {transcripts?.length > 0 && (
                  <>
                    <button
                      onClick={handleGenerateSummary}
                      disabled={summaryStatus === 'processing'}
                      className={`px-3.5 py-2 rounded-rw-md inline-flex items-center gap-2 text-[13px] font-medium transition-colors ${
                        summaryStatus === 'processing'
                          ? 'bg-rw-warning-bg text-rw-warning-text cursor-wait'
                          : 'bg-rw-primary text-rw-text-on-primary hover:bg-rw-primary-hover'
                      }`}
                      title={
                        summaryStatus === 'processing'
                          ? 'Generating summary...'
                          : 'Generate AI Summary'
                      }
                    >
                      {summaryStatus === 'processing' ? (
                        <>
                          <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          <span>Processing…</span>
                        </>
                      ) : (
                        <>
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          <span>Generate Summary</span>
                          <kbd className="ml-1 font-mono text-[10px] text-rw-text-on-primary/80 bg-white/15 border border-white/25 rounded-sm px-1 py-0.5">
                            ⌘G
                          </kbd>
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => setShowCustomPrompt(true)}
                      className="w-9 h-9 border border-rw-border bg-rw-card rounded-rw-md inline-flex items-center justify-center text-rw-text-secondary hover:bg-rw-hover hover:text-rw-text-primary hover:border-rw-border-strong transition-colors"
                      title="Custom summary prompt for this meeting"
                      aria-label="Custom summary prompt"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
              {/* Selected-template caption — names the prompt that
                  the next Generate / Regenerate will use. Click the
                  gear icon to change it. */}
              {transcripts?.length > 0 && (
                <p className="text-[11px] text-rw-text-tertiary mt-1">
                  Using: <span className="text-rw-text-secondary">{selectedTemplateLabel}</span>
                </p>
              )}
            </div>
          </div>

          {/* Transcript content */}
          <div className="flex-1 overflow-y-auto pb-32">
            <TranscriptView
              transcripts={transcripts}
              speakerMap={speakerMap}
              onSpeakerRename={async (original, newName) => {
                const updates: Record<string, string | null> = { [original]: newName };
                setSpeakerMap((prev) => {
                  const next = { ...prev };
                  if (newName) next[original] = newName;
                  else delete next[original];
                  return next;
                });
                try {
                  await fetch(
                    `http://localhost:5167/meetings/${meeting.id}/speaker-map`,
                    {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ updates }),
                    },
                  );
                } catch {
                  // best-effort — local state is already updated
                }
              }}
            />
          </div>
        </div>

        {/* Phase 4 Task 2.5: AI Summary card is the right-pane hero —
            slight visual lift via a 1.5px teal-tinted border instead
            of the neutral rw-border on the transcript pane. */}
        <div
          className="flex-[1.1] m-4 ml-2 bg-rw-card rounded-rw-lg overflow-y-auto"
          style={{ border: '1.5px solid var(--rw-primary-border)' }}
        >
          {isSummaryLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-rw-primary mb-4"></div>
                <p className="text-rw-text-secondary text-[14px]">Generating AI Summary…</p>
              </div>
            </div>
          ) : transcripts?.length > 0 && (
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
                {/* Q&A scoped to this recording. Collapsed by default
                    so it costs one row above the summary until used. */}
                <div className="mb-4">
                  <MeetingAskPanel
                    meetingId={meeting.id}
                    meetingTitle={meetingTitle}
                  />
                </div>
                <AISummary
                  summary={aiSummary}
                  status={summaryStatus} 
                  error={summaryError}
                  onSummaryChange={(newSummary) => {
                    setAiSummary(newSummary);
                    // Phase 3 Task 7.5: any user-driven change (block
                    // edit, delete, add section, undo, redo, etc.)
                    // routes through here, so flipping the flag once
                    // is enough to gate Regenerate.
                    setSummaryModified(true);
                  }}
                  onRegenerateSummary={() => {
                    handleRegenerateSummary();
                  }}
                  meeting={{
                    id: meeting.id,
                    title: meetingTitle,
                    created_at: meeting.created_at
                  }}
                />
              </div>
              {summaryStatus !== 'idle' && (
                <div className={`mt-4 px-3 py-2 rounded-rw-md inline-flex items-center gap-2 ${
                  summaryStatus === 'error'
                    ? 'bg-rw-danger-bg text-rw-danger-text'
                    : summaryStatus === 'completed'
                    ? 'bg-rw-success-bg text-rw-success-text'
                    : 'bg-rw-info-bg text-rw-info-text'
                }`}>
                  <p className="text-[12px] font-medium">{getSummaryStatusMessage(summaryStatus)}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Phase 4 Task 1B: per-meeting custom summary prompt. The
            modal handles its own load/save round-trip; we only pass
            the current regenerate handler so Save & Regenerate kicks
            off the existing poll-and-rename flow. */}
        <CustomSummaryPromptModal
          meetingId={meeting.id}
          open={showCustomPrompt}
          onClose={() => setShowCustomPrompt(false)}
          onRegenerate={async () => {
            // The modal's Save & Regenerate is a single button; if the
            // user has never run a summary in this session,
            // originalTranscript is still empty and the regenerate
            // path would silently no-op. Fall back to the from-
            // scratch generate flow in that case so the saved custom
            // prompt actually drives a fresh summary.
            if (originalTranscript.trim()) {
              await handleRegenerateSummary();
            } else {
              await generateAISummary();
            }
          }}
        />

        {/* Phase 3 Task 9: move-to-folder confirmation. Shown when the
            target folder has a default prompt that differs from the
            previous folder's. The move has already happened; this
            dialog only governs whether that folder's prompt is
            persisted onto the meeting + the summary regenerated.
            Skip preserves any existing manual prompt. */}
        {pendingMovePrompt && (
          <>
            <div
              className="fixed inset-0 z-[60]"
              style={{ backgroundColor: 'rgba(0, 0, 0, 0.4)' }}
              onClick={() => !applyingPrompt && setPendingMovePrompt(null)}
            />
            <div
              className="fixed left-1/2 top-1/2 z-[61] w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-rw-lg border border-rw-border bg-rw-card shadow-xl"
              // Hotfix: var(--rw-color-bg-card) doesn't exist (the
              // actual variable is --rw-bg-card). Without the right
              // name resolving the panel was transparent and the page
              // bled through.
              style={{ backgroundColor: 'var(--rw-bg-card)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-5 py-4 border-b border-rw-border">
                <div className="text-[15px] font-medium text-rw-text-primary">
                  Apply &ldquo;{pendingMovePrompt.promptName}&rdquo; template?
                </div>
              </div>
              <div className="px-5 py-4 text-[13px] text-rw-text-secondary">
                {pendingMovePrompt.hadCustomPrompt ? (
                  <>
                    Meetings in &ldquo;{pendingMovePrompt.folderName}&rdquo;
                    use this template by default. Replace the existing
                    prompt for this meeting and regenerate the summary?
                  </>
                ) : (
                  <>
                    Meetings in &ldquo;{pendingMovePrompt.folderName}&rdquo;
                    use this template by default. Apply it to this
                    meeting and regenerate the summary?
                  </>
                )}
              </div>
              <div className="flex justify-end gap-2 px-5 py-3 border-t border-rw-border">
                <button
                  type="button"
                  disabled={applyingPrompt}
                  onClick={() => setPendingMovePrompt(null)}
                  className="px-3 py-1.5 text-[13px] text-rw-text-secondary hover:text-rw-text-primary"
                >
                  Skip
                </button>
                <button
                  type="button"
                  disabled={applyingPrompt}
                  onClick={async () => {
                    const target = pendingMovePrompt;
                    setApplyingPrompt(true);
                    try {
                      // PATCH the meeting's custom prompt to the
                      // folder default's prompt_text. Backend tags
                      // source='manual' here — the user explicitly
                      // accepted the application, so any later
                      // regenerate uses the same prompt rather than
                      // silently re-resolving the folder default.
                      await fetch(
                        `http://localhost:5167/meetings/${meeting.id}/custom-prompt`,
                        {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ prompt: target.promptText }),
                        },
                      );
                      setPendingMovePrompt(null);
                      // Trigger regenerate (or first-generate) so the
                      // new template's structure shows up immediately.
                      if (originalTranscript.trim()) {
                        await handleRegenerateSummary();
                      } else if (transcripts.length) {
                        await generateAISummary();
                      }
                    } catch (err) {
                      console.error('Apply folder default prompt failed', err);
                      setPendingMovePrompt(null);
                    } finally {
                      setApplyingPrompt(false);
                    }
                  }}
                  className="px-3 py-1.5 text-[13px] font-medium rounded-rw-md bg-rw-primary text-white hover:opacity-90 disabled:opacity-60"
                >
                  {applyingPrompt ? 'Applying…' : 'Apply'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}



