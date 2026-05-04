"use client";
import { useState, useEffect, useCallback } from 'react';
import { Transcript, Summary, SummaryResponse } from '@/types';
import { EditableTitle } from '@/components/EditableTitle';
import { TranscriptView } from '@/components/TranscriptView';
import { AISummary } from '@/components/AISummary';
import { CurrentMeeting, useSidebar } from '@/components/Sidebar/SidebarProvider';
import { ModelSettingsModal, ModelConfig } from '@/components/ModelSettingsModal';

type SummaryStatus = 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';

export default function PageContent({ meeting, summaryData }: { meeting: any, summaryData: Summary }) {
  const [transcripts, setTranscripts] = useState<Transcript[]>(meeting.transcripts);
  const [showSummary, setShowSummary] = useState(false);
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>('idle');
  const [meetingTitle, setMeetingTitle] = useState(meeting.title || '+ New Call');
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
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [originalTranscript, setOriginalTranscript] = useState<string>('');
  const [error, setError] = useState<string>('');
  const {
    setCurrentMeeting,
    setMeetings,
    // Phase 3 Task 7: organization state + actions.
    folders,
    tags: allTags,
    setMeetingFolder,
    addMeetingTag,
    removeMeetingTag,
  } = useSidebar();
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
      const response = await fetch('http://localhost:5167/process-transcript', {
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
            const { MeetingName, ...summaryData } = result.data;

            // Update meeting title if available
            if (MeetingName) {
              setMeetingTitle(MeetingName);
              setMeetings((prev: CurrentMeeting[]) => prev.map(m => m.id === meeting.id ? { ...m, title: MeetingName } : m));
              setCurrentMeeting({ id: meeting.id, title: MeetingName });
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
      const response = await fetch('http://localhost:5167/process-transcript', {
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
            const { MeetingName, ...summaryData } = result.data;
            
            // Update meeting title if available
            if (MeetingName) {
              setMeetingTitle(MeetingName);
              setMeetings((prev: CurrentMeeting[]) => prev.map(m => m.id === meeting.id ? { ...m, title: MeetingName } : m));
              setCurrentMeeting({ id: meeting.id, title: MeetingName });
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
    const fullTranscript = transcripts
      .map(t => `${t.timestamp}: ${t.text}`)
      .join('\n');
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

  const handleSaveModelConfig = async (updatedConfig?: ModelConfig) => {
    try {
      const configToSave = updatedConfig || modelConfig;
      const payload = {
        provider: configToSave.provider,
        model: configToSave.model,
        whisperModel: configToSave.whisperModel,
        apiKey: configToSave.apiKey ?? null
      };
      console.log('Saving model config with payload:', payload);
      
      const response = await fetch('http://localhost:5167/save-model-config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Save model config failed:', errorData);
        console.error('Response status:', response.status);
        throw new Error(errorData.error || 'Failed to save model config');
      }

      const responseData = await response.json();
      console.log('Save model config success:', responseData);

      setModelConfig(payload);
    } catch (error) {
      console.error('Failed to save model config:', error);
      if (error instanceof Error) {
        setError(error.message);
      } else {
        setError('Failed to save model config: Unknown error');
      } 
    }
  };

  const isSummaryLoading = summaryStatus === 'processing' || summaryStatus === 'summarizing' || summaryStatus === 'regenerating';

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="flex flex-1 overflow-hidden">
        {/* Left side - Transcript */}
        <div className="w-1/3 min-w-[300px] border-r border-gray-200 bg-white flex flex-col relative">
          {/* Title area */}
          <div className="p-4 border-b border-gray-200">
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
              {/* Phase 3 Task 7: folder selector. "Uncategorized" is the
                  default option and represents folder_id=null. Changing
                  the dropdown calls the SidebarContext method which
                  pushes to backend AND updates the global meetings
                  state so the sidebar moves the meeting to the new
                  folder without a refetch. */}
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-500">Folder:</span>
                <select
                  value={folderId ?? ''}
                  onChange={async (e) => {
                    const newFolderId = e.target.value || null;
                    const ok = await setMeetingFolder(meeting.id, newFolderId);
                    if (ok) setFolderId(newFolderId);
                  }}
                  className="px-2 py-1 border border-gray-300 rounded-md bg-white hover:border-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200"
                    title={tag.name}
                  >
                    <span className="text-xs">#{tag.name}</span>
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
                      className="text-blue-400 hover:text-blue-700 leading-none"
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
                    className="px-2 py-0.5 rounded-full text-xs text-gray-500 hover:bg-gray-100 border border-dashed border-gray-300"
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
              <div className="flex items-center space-x-2">
                <button
                  onClick={handleCopyTranscript}
                  disabled={transcripts?.length === 0}
                  className={`px-3 py-2 border rounded-md transition-all duration-200 inline-flex items-center gap-2 shadow-sm ${
                    transcripts?.length === 0
                      ? 'bg-gray-50 border-gray-200 text-gray-400 cursor-not-allowed'
                      : 'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100 hover:border-blue-300 active:bg-blue-200'
                  }`}
                  title={transcripts?.length === 0 ? 'No transcript available' : 'Copy Transcript'}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" fill="none">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V7.5l-3.75-3.612z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 3v3.75a.75.75 0 0 0 .75.75H18" />
                  </svg>
                  <span className="text-sm">Copy Transcript</span>
                </button>
                {transcripts?.length > 0 && (
                  <>
                    <button
                      onClick={handleGenerateSummary}
                      disabled={summaryStatus === 'processing'}
                      className={`px-3 py-2 border rounded-md transition-all duration-200 inline-flex items-center gap-2 shadow-sm ${
                        summaryStatus === 'processing'
                          ? 'bg-yellow-50 border-yellow-200 text-yellow-700'
                          : 'bg-green-50 border-green-200 text-green-700 hover:bg-green-100 hover:border-green-300 active:bg-green-200'
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
                    <button
                      onClick={() => setShowModelSettings(true)}
                      className="px-3 py-2 border rounded-md transition-all duration-200 inline-flex items-center gap-2 shadow-sm bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100 hover:border-gray-300 active:bg-gray-200"
                      title="Model Settings"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Transcript content */}
          <div className="flex-1 overflow-y-auto pb-32">
            <TranscriptView transcripts={transcripts} />
          </div>
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

        {/* Model Settings Modal */}
        {showModelSettings && (
          <ModelSettingsModal
            showModelSettings={showModelSettings}
            setShowModelSettings={setShowModelSettings}
            modelConfig={modelConfig}
            setModelConfig={setModelConfig}
            onSave={handleSaveModelConfig}
          />
        )}
      </div>
    </div>
  );
}



