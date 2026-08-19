'use client';

import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { bucketMeetings } from '@/lib/date-buckets';
import { authFetch } from '@/lib/authFetch';


// Phase 5 Task 1: shape of the save-failed Tauri event Rust emits when
// either /transcribe-audio or /save-transcript fails. The recovery_path
// is an absolute filesystem path the user can paste into
// scripts/recover_recording.py. seenAt is local-only — used to dismiss
// the toast and never re-show the same payload after the user closes
// it.
interface SaveFailedPayload {
  kind: string; // "transcribe" | "save-transcript"
  recovery_path: string;
  error: string;
  meeting_id: string | null;
}

interface SaveFailedState extends SaveFailedPayload {
  seenAt: number;
}

// Phase 3 Task 5: 'header' is a non-interactive section label used for
// date-bucket grouping inside the Meetings group. Renderer skips
// click handlers, hover state, and icon for type='header'.
interface SidebarItem {
  id: string;
  title: string;
  type: 'folder' | 'file' | 'header';
  children?: SidebarItem[];
  created_at?: string;
}

export interface CurrentMeeting {
  id: string;
  title: string;
  // Phase 3 Task 5: optional ISO 8601 timestamp surfaced from the
  // /get-meetings response so the sidebar can date-bucket meetings.
  // Optional because the existing setCurrentMeeting({id:'intro-call',
  // title:'+ New Call'}) call sites don't carry one.
  created_at?: string;
  // Phase 3 Task 7: organization. folder_id is null for uncategorized
  // meetings. tags is an array of {id, name}.
  folder_id?: string | null;
  tags?: TagSummary[];
}

// Phase 3 Task 7: organization types.
export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at?: string;
  // Phase 3 Task 9: per-folder default summary prompt. id is the FK
  // into saved_prompts.id; name + category are denormalised from the
  // joined row so the sidebar / Settings render the prompt without an
  // extra fetch. All three are null when no default is set OR when
  // the referenced prompt has been deleted (the FK's ON DELETE
  // SET NULL clears the id).
  default_prompt_id?: number | null;
  default_prompt_name?: string | null;
  default_prompt_category?: string | null;
}

// Phase 3 Task 9: minimal saved-prompt shape exposed via the sidebar
// context so the folder edit modal, Settings page, and move-to-folder
// confirmation dialog can read the library without each refetching
// /saved-prompts. Includes prompt_text so the move-confirmation can
// PATCH a folder default's prompt onto a meeting without an extra
// round-trip. Single-user app; the full library is small.
export interface SavedPromptOption {
  id: number;
  name: string;
  category: string;
  prompt_text: string;
}

export interface Tag {
  id: string;
  name: string;
  usage_count?: number;
  created_at?: string;
}

// A tag attached to a meeting — same shape as Tag minus the optional
// usage_count which is global. Re-exported as a separate name so the
// CurrentMeeting type can refer to it without dragging in usage_count.
export type TagSummary = Pick<Tag, 'id' | 'name'>;

export type RecorderState = 'Idle' | 'Potential' | 'Recording' | 'Finalizing';

// Phase 8 Task 9: background summary jobs that were kicked off
// automatically when meeting-saved fired. Lives in SidebarProvider so
// it survives route changes (a job started on Home keeps running while
// the user navigates to /meeting-details for a different meeting, then
// stops at /admin, etc). Sidebar consumes this to show per-row
// spinners; Settings consumes the count for a header pill.
export type SummaryJobStage =
  | 'processing'   // POST /process-transcript in flight
  | 'polling'     // process_id obtained, polling /get-summary/{id}
  | 'error';       // last attempt failed; stays in map briefly so UI can surface

export interface SummaryJob {
  meeting_id: string;
  stage: SummaryJobStage;
  started_at: number;
  error?: string;
}

interface SidebarContextType {
  currentMeeting: CurrentMeeting | null;
  setCurrentMeeting: (meeting: CurrentMeeting | null) => void;
  sidebarItems: SidebarItem[];
  isCollapsed: boolean;
  toggleCollapse: () => void;
  // Drag-to-resize width in px (expanded state only). Persisted to
  // localStorage so it survives restarts.
  sidebarWidth: number;
  setSidebarWidth: (px: number) => void;
  // True while the user is dragging the resize divider — consumers
  // suppress width transitions so the content tracks the cursor.
  isResizingSidebar: boolean;
  setIsResizingSidebar: (v: boolean) => void;
  meetings: CurrentMeeting[];
  setMeetings: React.Dispatch<React.SetStateAction<CurrentMeeting[]>>;
  setIsMeetingActive: React.Dispatch<React.SetStateAction<boolean>>;
  isMeetingActive: boolean;
  // Phase 2b round 6: recording session state lives here so the
  // listeners are always attached, regardless of which route the user
  // is on. Previously these lived in `Home` only — when the user was
  // on /meeting-details when auto-detect fired, the events arrived to
  // no listener and the UI stayed dark until a refresh.
  recorderState: RecorderState;
  recordingTitle: string | null;
  recordingSource: string | null;
  recordingConfidence: string | null;
  setRecordingTitle: (title: string | null) => void;
  // Phase 3 Task 7: folders + tags as global state. CRUD methods
  // mutate the backend, then update local state on success so the
  // sidebar / meeting-details views re-render without a refetch.
  folders: Folder[];
  tags: Tag[];
  // Phase 3 Task 9: saved-prompt options surfaced globally so the
  // folder-edit dialog and Settings folder-defaults table can populate
  // their categorized dropdowns without each refetching the library.
  savedPrompts: SavedPromptOption[];
  refreshSavedPrompts: () => Promise<void>;
  refreshFolders: () => Promise<void>;
  createFolder: (name: string, parent_id?: string | null) => Promise<Folder | null>;
  renameFolder: (folder_id: string, name: string) => Promise<boolean>;
  deleteFolder: (folder_id: string) => Promise<boolean>;
  // Phase 3 Task 9: assign or clear a folder's default summary prompt.
  // Pass prompt_id=null to clear. Updates local state on success.
  setFolderDefaultPrompt: (
    folder_id: string,
    prompt_id: number | null,
  ) => Promise<boolean>;
  setMeetingFolder: (meeting_id: string, folder_id: string | null) => Promise<boolean>;
  // Phase 5 Task 2: in-pane welcome panel state.
  //   null  = still loading (fetch in flight on mount)
  //   false = first launch, panel should render
  //   true  = dismissed, render normal main pane
  // dismissWelcomePanel flips the flag locally and fires a
  // best-effort PATCH /settings/onboarding (no await on the network
  // round-trip from the caller's POV).
  hasSeenWelcomePanel: boolean | null;
  dismissWelcomePanel: () => void;
  // Phase 8 Task 9: auto-summarize state + background jobs.
  // autoSummarizeEnabled is null while the initial /settings/recording
  // fetch is in flight; rendering should NOT trigger anything new
  // during that window. setAutoSummarizeEnabled persists to the
  // backend.
  autoSummarizeEnabled: boolean | null;
  setAutoSummarizeEnabled: (next: boolean) => Promise<void>;
  // runningJobs is keyed by meeting_id. Mutations always replace the
  // map (immutable) so React detects the change.
  runningJobs: Map<string, SummaryJob>;
  // Helper consumers can use without pulling the whole map into their
  // dependency arrays.
  isJobRunning: (meeting_id: string) => boolean;
  runningJobsCount: number;
  addMeetingTag: (
    meeting_id: string,
    tag: { id?: string; name?: string }
  ) => Promise<TagSummary[] | null>;
  removeMeetingTag: (meeting_id: string, tag_id: string) => Promise<boolean>;
}

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_COLLAPSED_WIDTH = 64;

const SidebarContext = createContext<SidebarContextType | null>(null);

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return context;
};

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [currentMeeting, setCurrentMeeting] = useState<CurrentMeeting | null>({ id: 'intro-call', title: '+ New Call' });
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [meetings, setMeetings] = useState<CurrentMeeting[]>([]);
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarItems, setSidebarItems] = useState<SidebarItem[]>([]);
  const [isMeetingActive, setIsMeetingActive] = useState(false);
  const [recorderState, setRecorderState] = useState<RecorderState>('Idle');
  const [recordingTitle, setRecordingTitle] = useState<string | null>(null);
  const [recordingSource, setRecordingSource] = useState<string | null>(null);
  const [recordingConfidence, setRecordingConfidence] = useState<string | null>(null);
  // Phase 5 Task 1: latest save-failed event (or null when no failure
  // pending). The toast renders directly off this state and dismisses
  // by setting it back to null.
  const [saveFailure, setSaveFailure] = useState<SaveFailedState | null>(null);
  // Phase 6 Task 7: in-flight save status. Toasted while the audio is
  // being transcribed and persisted (5-30s window where the meeting
  // hasn't shown up in the sidebar yet) so the user knows the app
  // didn't silently fail. Set on `transcribing-started`; flipped to
  // 'saved' on `meeting-saved` for ~3s then cleared; cleared
  // immediately if the save-failed flow takes over.
  const [processingSave, setProcessingSave] = useState<{
    meeting_id: string;
    title: string;
    stage: 'transcribing' | 'saved';
  } | null>(null);
  // Phase 3 Task 7: folders + tags state. Loaded on mount alongside
  // meetings; mutations go through the CRUD methods below which keep
  // local state and the backend in sync without a full refetch.
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  // Phase 3 Task 9: cached saved-prompt options for the folder edit
  // modal + Settings folder-defaults table.
  const [savedPrompts, setSavedPrompts] = useState<SavedPromptOption[]>([]);
  // Phase 5 Task 2: in-pane welcome panel flag, fetched from
  // /settings/recording on mount. Null while loading so the home
  // page doesn't briefly render the wrong state during the first
  // 50ms.
  const [hasSeenWelcomePanel, setHasSeenWelcomePanel] = useState<
    boolean | null
  >(null);
  // Phase 8 Task 9: auto-summarize toggle + background job map.
  // Null until /settings/recording resolves; treat null as "don't
  // auto-summarize yet" inside the meeting-saved listener so we
  // never fire a stray job before the user's stored preference is
  // known.
  const [autoSummarizeEnabled, setAutoSummarizeEnabledState] = useState<
    boolean | null
  >(null);
  const [runningJobs, setRunningJobs] = useState<Map<string, SummaryJob>>(
    () => new Map()
  );
  // Phase 8 Task 9: refs so the mount-time meeting-saved listener can
  // read the latest auto-summarize toggle and call the latest job
  // starter without re-attaching when those values change.
  const autoSummarizeRef = useRef<boolean | null>(null);
  const startBackgroundSummaryRef = useRef<
    ((meeting_id: string, transcriptText: string) => void) | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    const opts = {
      cache: 'no-store' as RequestCache,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    };

    const fetchOnce = async () => {
      const [mResp, fResp, tResp, spResp, rsResp] = await Promise.all([
        fetch('http://localhost:5167/get-meetings', opts),
        fetch('http://localhost:5167/folders', opts),
        fetch('http://localhost:5167/tags', opts),
        fetch('http://localhost:5167/saved-prompts', opts),
        // Phase 5 Task 2: welcome panel flag lives here.
        fetch('http://localhost:5167/settings/recording', opts),
      ]);
      // Treat any non-2xx among the critical endpoints as a failure
      // worth retrying — covers the case where the backend is
      // up-and-listening but its DB connection or DI isn't ready
      // yet (returns 500 transiently during cold start).
      if (!mResp.ok || !fResp.ok || !tResp.ok) {
        throw new Error(
          `core endpoints not ready: m=${mResp.status} f=${fResp.status} t=${tResp.status}`,
        );
      }
      const [mData, fData, tData, spData, rsData] = await Promise.all([
        mResp.json(),
        fResp.json(),
        tResp.json(),
        spResp.ok ? spResp.json() : Promise.resolve([]),
        rsResp.ok ? rsResp.json() : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const transformedMeetings = mData.map((meeting: any) => ({
        id: meeting.id,
        title: meeting.title,
        // Phase 3 Task 5: created_at for date-bucket grouping.
        created_at: meeting.created_at,
        // Phase 3 Task 7: organization fields. Defaults handle
        // backward-compat with an older backend that doesn't ship
        // them yet.
        folder_id: meeting.folder_id ?? null,
        tags: meeting.tags ?? [],
      }));
      setMeetings(transformedMeetings);
      setFolders(Array.isArray(fData) ? fData : []);
      setTags(Array.isArray(tData) ? tData : []);
      // Phase 3 Task 9: shrink saved-prompt rows down to id/name/category
      // — that's all the categorized dropdown needs. Full prompt_text
      // stays in CustomSummaryPromptModal's own fetch.
      setSavedPrompts(
        Array.isArray(spData)
          ? spData.map((p: any) => ({
              id: p.id,
              name: p.name,
              category: p.category,
              prompt_text: p.prompt_text ?? '',
            }))
          : [],
      );
      // Phase 5 Task 2: welcome flag. If the fetch failed (rsData
      // is null) treat it as already-seen — don't show a welcome
      // panel based on a missing backend response. Defaults from
      // get_recording_settings are conservative enough for fresh
      // installs; a transient error shouldn't trigger a flash.
      const welcomeSeen =
        rsData?.has_seen_welcome_panel === undefined
          ? true
          : Boolean(rsData.has_seen_welcome_panel);
      setHasSeenWelcomePanel(welcomeSeen);
      // Phase 8 Task 9: read auto-summarize preference. Default ON
      // for fresh installs (matches backend default), and ON when
      // the field is missing from an older response.
      const autoSum =
        rsData?.auto_summarize_enabled === undefined
          ? true
          : Boolean(rsData.auto_summarize_enabled);
      setAutoSummarizeEnabledState(autoSum);
      // Phase 5 Task 2 hotfix: force the sidebar OPEN on first
      // launch so the user can actually see "+ New Call" and the
      // sample meeting that the welcome panel tells them to click.
      // Only on first launch — returning users keep their toggled
      // preference (the default isCollapsed=true above stands
      // unless we override here).
      if (!welcomeSeen) {
        setIsCollapsed(false);
      }
      router.push('/');
    };

    // Retry the initial sidebar fetch on cold-start race with the
    // FastAPI backend. Without this, opening the Tauri window before
    // Uvicorn finishes binding port 5167 leaves the sidebar empty
    // until the user hits Ctrl+R.
    //
    // 8 attempts at 0/1/2/4/8/8/8/8s = ~39s of grace before we give
    // up — earlier 15s budget wasn't enough on slower cold venv
    // boots. After exhausting the retries the catch arm below wipes
    // state so the user sees a known-empty sidebar rather than
    // pre-load placeholders forever; the focus listener below then
    // takes over for self-healing.
    const fetchWithRetry = async () => {
      const delays = [0, 1000, 2000, 4000, 8000, 8000, 8000, 8000];
      for (let attempt = 0; attempt < delays.length; attempt++) {
        if (cancelled) return;
        if (delays[attempt] > 0) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
          if (cancelled) return;
        }
        try {
          await fetchOnce();
          return; // success; bail out of the retry loop
        } catch (error) {
          if (attempt === delays.length - 1) {
            console.error(
              'Error fetching sidebar data after retries:',
              error,
            );
            if (cancelled) return;
            setMeetings([]);
            setFolders([]);
            setTags([]);
            setSavedPrompts([]);
            setHasSeenWelcomePanel(true);
          } else {
            console.warn(
              `Sidebar fetch attempt ${attempt + 1} failed; retrying`,
              error,
            );
          }
        }
      }
    };
    fetchWithRetry();

    // Self-heal: refetch whenever the user gives the Tauri window
    // focus or the tab becomes visible again. Covers two cases:
    //   1. Initial load — when Tauri opens the webview, focus
    //      arrives a beat after mount, triggering a second attempt
    //      against an by-then-ready backend.
    //   2. User came back from another app / had the app
    //      backgrounded while recording.
    // Skipped while a fetch is already in-flight (refetchInFlight
    // is closed-over) so we don't pile concurrent fetches.
    let refetchInFlight = false;
    const safeRefetch = async () => {
      if (cancelled || refetchInFlight) return;
      refetchInFlight = true;
      try {
        await fetchOnce();
      } catch (e) {
        console.warn('Focus refetch failed (non-fatal)', e);
      } finally {
        refetchInFlight = false;
      }
    };
    const onFocus = () => {
      void safeRefetch();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void safeRefetch();
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Phase 5 Task 2: dismiss the welcome panel. Fire-and-forget the
  // PATCH so the UI is responsive even on a slow backend; flip the
  // local flag immediately so the panel disappears without waiting.
  const dismissWelcomePanel = () => {
    if (hasSeenWelcomePanel === true) return; // already dismissed
    setHasSeenWelcomePanel(true);
    fetch('http://localhost:5167/settings/onboarding', {
      method: 'PATCH',
    }).catch((e) => {
      console.warn('PATCH /settings/onboarding failed (non-fatal)', e);
    });
  };

  // Phase 8 Task 9: persist the auto-summarize toggle. Optimistically
  // flip the local state so the UI is responsive, then POST. On
  // failure, fall back to the previous value.
  const setAutoSummarizeEnabled = async (next: boolean): Promise<void> => {
    const prev = autoSummarizeEnabled;
    setAutoSummarizeEnabledState(next);
    try {
      const resp = await fetch('http://localhost:5167/settings/recording', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_summarize_enabled: next }),
      });
      if (!resp.ok) throw new Error(`status ${resp.status}`);
    } catch (e) {
      console.error('setAutoSummarizeEnabled failed', e);
      setAutoSummarizeEnabledState(prev);
    }
  };

  // Phase 8 Task 9: background job map helpers. Mutating helpers
  // always rebuild the Map so React detects identity change.
  const setJob = (meeting_id: string, job: SummaryJob) => {
    setRunningJobs((prev) => {
      const next = new Map(prev);
      next.set(meeting_id, job);
      return next;
    });
  };
  const clearJob = (meeting_id: string) => {
    setRunningJobs((prev) => {
      if (!prev.has(meeting_id)) return prev;
      const next = new Map(prev);
      next.delete(meeting_id);
      return next;
    });
  };
  const isJobRunning = (meeting_id: string): boolean =>
    runningJobs.has(meeting_id);
  const runningJobsCount = runningJobs.size;

  // Phase 8 Task 9: kick off a background summary for a freshly-saved
  // meeting. Mirrors the page.tsx generateAISummary flow but without
  // any UI binding — pure fire-and-forget against the backend. The
  // sidebar's per-row spinner reflects state via runningJobs.
  //
  // Critically: this function does NOT await the polling loop. It
  // returns as soon as the initial POST is queued so the caller (the
  // meeting-saved listener) doesn't block other listeners.
  const startBackgroundSummary = (meeting_id: string, transcriptText: string) => {
    if (!transcriptText.trim()) {
      console.warn(
        '[Phase8 t9] empty transcript for', meeting_id,
        '— skipping auto-summary'
      );
      return;
    }
    setJob(meeting_id, {
      meeting_id,
      stage: 'processing',
      started_at: Date.now(),
    });

    (async () => {
      try {
        const resp = await authFetch('http://localhost:5167/process-transcript', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: transcriptText,
            model: 'gemini',
            model_name: 'gemini-2.5-flash',
            meeting_id,
            chunk_size: 40000,
            overlap: 1000,
          }),
        });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`process-transcript HTTP ${resp.status}: ${text.slice(0, 200)}`);
        }
        const { process_id } = await resp.json();
        if (!process_id) throw new Error('no process_id returned');
        setJob(meeting_id, {
          meeting_id,
          stage: 'polling',
          started_at: Date.now(),
        });

        // Poll /get-summary/{process_id} every 5s. Bound the total
        // wait to 15 minutes — anything longer means the backend has
        // genuinely stalled and the UI should clear the spinner so
        // the user can retry from the meeting-details page.
        const startedAt = Date.now();
        const maxWaitMs = 15 * 60 * 1000;
        while (Date.now() - startedAt < maxWaitMs) {
          await new Promise((r) => setTimeout(r, 5000));
          try {
            const sResp = await fetch(
              `http://localhost:5167/get-summary/${process_id}`
            );
            if (!sResp.ok) {
              const t = await sResp.text();
              throw new Error(`get-summary HTTP ${sResp.status}: ${t.slice(0, 200)}`);
            }
            const result = await sResp.json();
            if (result.status === 'error') {
              throw new Error(result.error || 'summary generation failed');
            }
            if (result.status === 'completed' && result.data) {
              clearJob(meeting_id);
              // If the backend renamed the meeting in MeetingName,
              // mirror that into local state so the sidebar row
              // updates without a full refetch.
              const newTitle = result.data?.MeetingName;
              if (newTitle && typeof newTitle === 'string') {
                setMeetings((prev) =>
                  prev.map((m) =>
                    m.id === meeting_id ? { ...m, title: newTitle } : m
                  )
                );
              }
              // Phase 8 Task 9: signal any open meeting-details page
              // that the summary it's looking at may have just been
              // generated in the background. The listener on that
              // page refetches when meeting_id matches.
              try {
                window.dispatchEvent(
                  new CustomEvent('neato-summary-completed', {
                    detail: { meeting_id },
                  })
                );
              } catch {
                /* dispatchEvent can't fail in practice; defensive */
              }
              return;
            }
          } catch (pollErr) {
            // Single-poll failure is not fatal — keep trying until
            // the wall-clock budget elapses.
            console.warn('[Phase8 t9] poll error (will retry):', pollErr);
          }
        }
        throw new Error('summary timed out after 15 minutes');
      } catch (err) {
        console.error('[Phase8 t9] background summary failed:', err);
        setJob(meeting_id, {
          meeting_id,
          stage: 'error',
          started_at: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        });
        // Clear the error state after 30s so a failed job doesn't
        // leave a spinner stuck forever. The user can retry manually
        // from the meeting-details page.
        setTimeout(() => clearJob(meeting_id), 30000);
      }
    })();
  };

  // Phase 8 Task 9: keep refs synced for the mount-time meeting-saved
  // listener. Running these on every render is cheap and guarantees
  // the listener always sees the latest closure.
  useEffect(() => {
    autoSummarizeRef.current = autoSummarizeEnabled;
  }, [autoSummarizeEnabled]);
  useEffect(() => {
    startBackgroundSummaryRef.current = startBackgroundSummary;
  });

  // Phase 3 Task 9: refreshers used by the folder edit modal and
  // Settings page so a freshly-created saved prompt or a folder default
  // change shows up immediately in the global state.
  const refreshSavedPrompts = async (): Promise<void> => {
    try {
      const resp = await fetch('http://localhost:5167/saved-prompts', {
        cache: 'no-store',
      });
      if (!resp.ok) return;
      const data = await resp.json();
      setSavedPrompts(
        Array.isArray(data)
          ? data.map((p: any) => ({
              id: p.id,
              name: p.name,
              category: p.category,
              prompt_text: p.prompt_text ?? '',
            }))
          : [],
      );
    } catch (e) {
      console.error('refreshSavedPrompts error:', e);
    }
  };

  const refreshFolders = async (): Promise<void> => {
    try {
      const resp = await fetch('http://localhost:5167/folders', {
        cache: 'no-store',
      });
      if (!resp.ok) return;
      const data: Folder[] = await resp.json();
      setFolders(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('refreshFolders error:', e);
    }
  };

  // ---------- Phase 3 Task 7: CRUD methods ----------

  const createFolder = async (
    name: string,
    parent_id: string | null = null
  ): Promise<Folder | null> => {
    try {
      const resp = await fetch('http://localhost:5167/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parent_id }),
      });
      if (!resp.ok) {
        console.error('createFolder failed:', resp.status, await resp.text());
        return null;
      }
      const folder: Folder = await resp.json();
      setFolders((prev) => [...prev, folder].sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      ));
      return folder;
    } catch (e) {
      console.error('createFolder error:', e);
      return null;
    }
  };

  const renameFolder = async (folder_id: string, name: string): Promise<boolean> => {
    try {
      const resp = await fetch(`http://localhost:5167/folders/${folder_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!resp.ok) {
        console.error('renameFolder failed:', resp.status, await resp.text());
        return false;
      }
      const updated: Folder = await resp.json();
      setFolders((prev) =>
        prev
          .map((f) => (f.id === folder_id ? updated : f))
          .sort((a, b) =>
            a.name.toLowerCase().localeCompare(b.name.toLowerCase())
          )
      );
      return true;
    } catch (e) {
      console.error('renameFolder error:', e);
      return false;
    }
  };

  const setFolderDefaultPromptImpl = async (
    folder_id: string,
    prompt_id: number | null,
  ): Promise<boolean> => {
    try {
      const resp = await fetch(`http://localhost:5167/folders/${folder_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // Send the field explicitly (including null to clear). The
        // backend uses Pydantic's model_fields_set to distinguish
        // "not provided" from "set to null", so a JSON.stringify({...})
        // path that omits null fields would silently leave the value
        // untouched.
        body: JSON.stringify({ default_prompt_id: prompt_id }),
      });
      if (!resp.ok) {
        console.error(
          'setFolderDefaultPrompt failed:',
          resp.status,
          await resp.text(),
        );
        return false;
      }
      const updated: Folder = await resp.json();
      setFolders((prev) => prev.map((f) => (f.id === folder_id ? updated : f)));
      return true;
    } catch (e) {
      console.error('setFolderDefaultPrompt error:', e);
      return false;
    }
  };

  const deleteFolder = async (folder_id: string): Promise<boolean> => {
    try {
      const resp = await fetch(`http://localhost:5167/folders/${folder_id}`, {
        method: 'DELETE',
      });
      if (!resp.ok) {
        console.error('deleteFolder failed:', resp.status, await resp.text());
        return false;
      }
      setFolders((prev) => prev.filter((f) => f.id !== folder_id));
      // Backend ON DELETE SET NULL uncategorizes any meetings in this
      // folder; mirror that locally so the UI doesn't briefly render
      // them under a now-missing folder.
      setMeetings((prev) =>
        prev.map((m) =>
          m.folder_id === folder_id ? { ...m, folder_id: null } : m
        )
      );
      return true;
    } catch (e) {
      console.error('deleteFolder error:', e);
      return false;
    }
  };

  const setMeetingFolderImpl = async (
    meeting_id: string,
    folder_id: string | null
  ): Promise<boolean> => {
    try {
      const resp = await fetch(
        `http://localhost:5167/meetings/${meeting_id}/folder`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder_id }),
        }
      );
      if (!resp.ok) {
        console.error('setMeetingFolder failed:', resp.status, await resp.text());
        return false;
      }
      setMeetings((prev) =>
        prev.map((m) => (m.id === meeting_id ? { ...m, folder_id } : m))
      );
      return true;
    } catch (e) {
      console.error('setMeetingFolder error:', e);
      return false;
    }
  };

  const addMeetingTag = async (
    meeting_id: string,
    tag: { id?: string; name?: string }
  ): Promise<TagSummary[] | null> => {
    try {
      const resp = await fetch(
        `http://localhost:5167/meetings/${meeting_id}/tags`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tag_id: tag.id ?? null,
            name: tag.name ?? null,
          }),
        }
      );
      if (!resp.ok) {
        console.error('addMeetingTag failed:', resp.status, await resp.text());
        return null;
      }
      const result = await resp.json();
      const newTags: TagSummary[] = result.tags ?? [];
      setMeetings((prev) =>
        prev.map((m) => (m.id === meeting_id ? { ...m, tags: newTags } : m))
      );
      // The tag may have been newly created — refresh global tag list.
      // Cheap one-shot refetch.
      try {
        const tResp = await fetch('http://localhost:5167/tags', {
          cache: 'no-store',
        });
        if (tResp.ok) {
          const tData = await tResp.json();
          if (Array.isArray(tData)) setTags(tData);
        }
      } catch {
        /* non-fatal */
      }
      return newTags;
    } catch (e) {
      console.error('addMeetingTag error:', e);
      return null;
    }
  };

  const removeMeetingTag = async (
    meeting_id: string,
    tag_id: string
  ): Promise<boolean> => {
    try {
      const resp = await fetch(
        `http://localhost:5167/meetings/${meeting_id}/tags/${tag_id}`,
        { method: 'DELETE' }
      );
      if (!resp.ok) {
        console.error('removeMeetingTag failed:', resp.status, await resp.text());
        return false;
      }
      const result = await resp.json();
      const newTags: TagSummary[] = result.tags ?? [];
      setMeetings((prev) =>
        prev.map((m) => (m.id === meeting_id ? { ...m, tags: newTags } : m))
      );
      return true;
    } catch (e) {
      console.error('removeMeetingTag error:', e);
      return false;
    }
  };

  // Phase 2b round 6: global recording-state listeners. SidebarProvider
  // wraps every route in layout.tsx and stays mounted for the app's
  // lifetime, so events emitted by Rust always reach a listener — no
  // matter where the user navigated. Home (and any other route) reads
  // the resulting state via useSidebar() instead of holding its own
  // copy.
  useEffect(() => {
    let cancelled = false;
    let unlistenState: (() => void) | undefined;
    let unlistenStarted: (() => void) | undefined;
    let unlistenSaved: (() => void) | undefined;
    let unlistenSaveFailed: (() => void) | undefined;
    // Phase 5 Task 1: separate handle so the legacy and new failure
    // listeners can be unregistered independently.
    let unlistenSaveFailedV2: (() => void) | undefined;
    // Phase 6 Task 7: in-flight processing toast handle.
    let unlistenTranscribing: (() => void) | undefined;

    const attachListener = async <T,>(
      event: string,
      handler: (e: { payload: T }) => void
    ): Promise<(() => void) | undefined> => {
      const fn = await listen<T>(event, handler);
      if (cancelled) {
        fn();
        return undefined;
      }
      return fn;
    };

    (async () => {
      // Mount-time reconciliation: if Rust is already in the middle of
      // a session (e.g. SidebarProvider just remounted because the
      // webview reloaded), seed our state from the canonical source.
      try {
        const snapshot = await invoke<{
          state: RecorderState;
          meeting_id: string | null;
          title: string | null;
          detection_source: string | null;
          detection_confidence: string | null;
          started_at: string | null;
          is_manual: boolean | null;
        }>('get_recording_state');
        if (cancelled) return;
        console.log('[Phase2b r6] sidebar mount-time recording snapshot:', snapshot);
        setRecorderState(snapshot.state);
        const active = snapshot.state === 'Recording' || snapshot.state === 'Finalizing';
        setIsMeetingActive(active);
        setRecordingTitle(snapshot.title);
        setRecordingSource(snapshot.detection_source);
        setRecordingConfidence(snapshot.detection_confidence);
      } catch (err) {
        console.warn('[Phase2b r6] get_recording_state failed', err);
      }
      if (cancelled) return;

      unlistenState = await attachListener<RecorderState>(
        'recorder-state',
        (event) => {
          console.log('[Phase2b r6] recorder-state:', event.payload);
          setRecorderState(event.payload);
          if (event.payload === 'Recording') {
            setIsMeetingActive(true);
          } else if (event.payload === 'Idle') {
            setIsMeetingActive(false);
            setRecordingTitle(null);
            setRecordingSource(null);
            setRecordingConfidence(null);
          }
        }
      );

      unlistenStarted = await attachListener<{
        meeting_id: string;
        title: string;
        label: string;
        confidence: string;
        is_manual: boolean;
      }>('recording-started', (event) => {
        console.log('[Phase2b r8] recording-started:', event.payload);
        // Rust supplies the canonical title (e.g. "Auto: Google Meet"
        // for auto, "Recording 2026-04-30 21:50" for manual). The
        // frontend just mirrors it.
        setRecordingTitle(event.payload.title);
        setRecordingSource(
          event.payload.is_manual ? 'manual' : event.payload.label
        );
        setRecordingConfidence(
          event.payload.is_manual ? 'manual' : event.payload.confidence
        );
        // Phase 8 Task 11: the previous round-8 logic force-navigated
        // the user to Home on every auto-detected start so they could
        // see the live transcript. With the persistent REC pill in the
        // sidebar header (always visible, click-to-return-to-Home),
        // forced navigation is no longer needed — and it actively
        // interrupts the user if they're reading a past meeting,
        // searching, or using Ask. Leave them where they are. The pill
        // is the cue that recording started; clicking it gets them to
        // the live transcript on Home.
      });

      unlistenSaved = await attachListener<{
        meeting_id: string;
        title: string;
        detection_source: string;
        detection_confidence: string;
        is_manual: boolean;
        transcript_count: number;
      }>('meeting-saved', (event) => {
        console.log('[Phase2b r6] meeting-saved:', event.payload);
        const { meeting_id, title, is_manual, transcript_count } = event.payload;
        // Phase 3 Task 5: stamp the optimistic insert with the
        // current local time so it lands in the "Today" bucket
        // immediately. The next /get-meetings refresh will replace
        // this with the canonical backend timestamp.
        setMeetings((prev) => [
          { id: meeting_id, title, created_at: new Date().toISOString() },
          ...prev,
        ]);
        // Phase 6 Task 7: flip the in-flight processing toast to its
        // "Saved" state and auto-dismiss after a short delay.
        setProcessingSave({ meeting_id, title, stage: 'saved' });
        if (is_manual) {
          setCurrentMeeting({ id: meeting_id, title });
          router.push('/meeting-details');
        }
        // Phase 8 Task 9: kick off auto-summary in the background.
        // Read autoSummarizeEnabled via the ref so this stays
        // current across re-renders — the listener closes over the
        // value at attach time otherwise.
        if (transcript_count > 0) {
          (async () => {
            try {
              const resp = await fetch(
                `http://localhost:5167/get-meeting/${meeting_id}`,
                { cache: 'no-store' }
              );
              if (!resp.ok) throw new Error(`get-meeting HTTP ${resp.status}`);
              const data = await resp.json();
              const text = (data.transcripts ?? [])
                .map((t: { text: string }) => t.text)
                .join('\n');
              if (!text.trim()) return;

              // Auto-summarize (gated on user setting).
              if (autoSummarizeRef.current === true) {
                startBackgroundSummaryRef.current?.(meeting_id, text);
              }

              // Speaker identification — always fire post-meeting,
              // fire-and-forget. The meeting-details page will pick up
              // the result on its next load or live poll.
              fetch('http://localhost:5167/identify-speakers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ meeting_id }),
              }).catch(() => {});
            } catch (err) {
              console.warn('[meeting-saved] post-meeting fetch failed', meeting_id, err);
            }
          })();
        }
      });

      unlistenSaveFailed = await attachListener<{
        meeting_id: string;
        error: string;
      }>('meeting-save-failed', (event) => {
        console.error('[Phase2b r6] meeting-save-failed:', event.payload);
        // Phase 6 Task 7: clear the in-flight toast — SaveFailedToast
        // takes over from here.
        setProcessingSave(null);
      });

      // Phase 5 Task 1: new save-failed event with recovery_path. Fires
      // when stop_recording → POST /transcribe-audio or POST
      // /save-transcript fails. The Rust side has already persisted the
      // captured WAV to %APPDATA%\NeatoRewind\recovery\ — surface a
      // sticky toast pointing the user at it. Rust ALSO emits the
      // legacy meeting-save-failed for backward compat, hence two
      // separate listeners.
      unlistenSaveFailedV2 = await attachListener<SaveFailedPayload>(
        'save-failed',
        (event) => {
          console.error('[Phase5 t1] save-failed:', event.payload);
          setSaveFailure({
            ...event.payload,
            seenAt: Date.now(),
          });
          setProcessingSave(null);
        },
      );

      // Phase 6 Task 7: emitted by Rust when StopRecording starts the
      // transcribe + save flow. Surfaces a non-sticky toast so the
      // user knows the gap between "recording stopped" and "meeting
      // appears in the sidebar" is the app working, not the app
      // hung. Cleared by the meeting-saved / save-failed listeners
      // above.
      unlistenTranscribing = await attachListener<{
        meeting_id: string;
        title: string;
      }>('transcribing-started', (event) => {
        console.log('[Phase6 t7] transcribing-started:', event.payload);
        setProcessingSave({
          meeting_id: event.payload.meeting_id,
          title: event.payload.title,
          stage: 'transcribing',
        });
      });
    })();

    return () => {
      cancelled = true;
      if (unlistenState) unlistenState();
      if (unlistenStarted) unlistenStarted();
      if (unlistenSaved) unlistenSaved();
      if (unlistenSaveFailed) unlistenSaveFailed();
      if (unlistenSaveFailedV2) unlistenSaveFailedV2();
      if (unlistenTranscribing) unlistenTranscribing();
    };
  }, [router]);

  // Phase 6 Task 7: auto-dismiss the "Saved" stage of the processing
  // toast after a short read time. The transcribing stage stays up
  // until meeting-saved or save-failed flips/clears it.
  useEffect(() => {
    if (processingSave?.stage !== 'saved') return;
    const t = setTimeout(() => {
      setProcessingSave((cur) =>
        cur && cur.stage === 'saved' ? null : cur,
      );
    }, 3500);
    return () => clearTimeout(t);
  }, [processingSave]);

  // Phase 3 Task 1: defense-in-depth filter so the legitimate
  // "+ New Call" action button at the top of the Meetings group can
  // never be shadow-duplicated by a saved-meeting row that happens
  // to share its id ('intro-call') or title ('+ New Call'). The
  // pre-Round-4 click-flow could persist a row with title="+ New Call"
  // when a user clicked Record+Stop in quick succession before
  // anything mutated the local meetingTitle default. Round 4 fixed
  // that flow (Rust generates the canonical title), but a similar
  // leak could surface from a future regression, a manual DB import,
  // or the user editing a meeting title to "+ New Call" via the
  // meeting-details page. Render-time filter is cheap and removes
  // the entire bug class.
  //
  // Also dedupe by id so meeting-saved firing twice for the same id
  // (e.g. if Rust ever retried the POST in a future round) doesn't
  // produce two rows with duplicate React keys.
  const seenIds = new Set<string>(['intro-call']);
  const filteredMeetings = meetings.filter((m) => {
    if (m.id === 'intro-call' || m.title === '+ New Call') return false;
    if (seenIds.has(m.id)) return false;
    seenIds.add(m.id);
    return true;
  });

  // Phase 3 Task 2: removed the Notes group entirely.
  //
  // Phase 3 Task 5: meetings are date-bucketed. The "+ New Call" action
  // button stays at children[0]; below it, each non-empty bucket gets a
  // header item ("Today" / "Yesterday" / "This Week" / "Earlier") followed
  // by its meetings. Empty buckets are skipped.
  //
  // Phase 3 Task 7: user folders sit BETWEEN the action buttons and the
  // date-bucketed section. Each folder renders as an expandable folder
  // item containing the meetings whose folder_id matches. Meetings with
  // a folder_id are EXCLUDED from the date-bucketed uncategorized section
  // so each meeting appears exactly once.
  //
  //   + New Call                 ← action (children[0])
  //   + New Folder               ← action (Phase 3 Task 7)
  //   <user folder A> (expandable) → its meetings
  //   <user folder B> (expandable) → its meetings
  //   TODAY (header)             ← uncategorized only, date-bucketed
  //     <uncategorized today>
  //   EARLIER (header)
  //     <uncategorized earlier>
  const meetingsChildren: SidebarItem[] = [
    { id: 'intro-call', title: '+ New Call', type: 'file' as const },
    // Phase 3 Task 7: sentinel id `__new_folder__` triggers the
    // inline-create input in Sidebar/index.tsx renderItem.
    { id: '__new_folder__', title: '+ New Folder', type: 'file' as const },
    // Phase 6 Task 4: sentinel for the YouTube import modal. The
    // sidebar renderer special-cases this id to open
    // YoutubeImportModal instead of navigating.
    { id: '__youtube_import__', title: '+ YouTube video', type: 'file' as const },
    // Phase 6 Task 4 (Option 1): sentinel for the system-audio
    // recording flow — for browser content that isn't on YouTube
    // (Loom, Vimeo, podcast players). Triggers the
    // manual_start_system_audio_only Tauri command which captures
    // system audio with the mic discarded at mix time.
    { id: '__system_audio_record__', title: '+ Browser audio', type: 'file' as const },
  ];

  // User folders, sorted by name (already sorted in `folders` state).
  for (const folder of folders) {
    const folderMeetings = filteredMeetings.filter(
      (m) => m.folder_id === folder.id
    );
    meetingsChildren.push({
      id: folder.id,
      title: folder.name,
      type: 'folder' as const,
      children: folderMeetings.map((m) => ({
        id: m.id,
        title: m.title,
        type: 'file' as const,
        created_at: m.created_at,
      })),
    });
  }

  // Date-bucket only the uncategorized meetings (folder_id null/missing).
  const uncategorized = filteredMeetings.filter(
    (m) => !m.folder_id
  );
  const bucketGroups = bucketMeetings(uncategorized);
  for (const group of bucketGroups) {
    meetingsChildren.push({
      id: `__header_${group.key}__`,
      title: group.label,
      type: 'header' as const,
    });
    for (const meeting of group.meetings) {
      meetingsChildren.push({
        id: meeting.id,
        title: meeting.title,
        type: 'file' as const,
        created_at: meeting.created_at,
      });
    }
  }

  const baseItems: SidebarItem[] = [
    {
      id: 'meetings',
      title: 'Meetings',
      type: 'folder' as const,
      children: meetingsChildren,
    },
  ];



  // Hotfix v3: functional setState form. The previous closed-over
  // !isCollapsed read could observe a stale value if React batched
  // multiple toggles or if the component re-rendered between
  // toggleCollapse being defined and called. Functional form
  // always toggles from the latest committed state.
  const toggleCollapse = () => {
    setIsCollapsed((prev) => !prev);
  };

  // Drag-to-resize sidebar width. Clamped in the drag handler; stored
  // here so MainContent can offset its left margin to match.
  const [sidebarWidth, setSidebarWidthState] = useState(256);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('neatoRewindSidebarWidth');
      if (saved) {
        const n = parseInt(saved, 10);
        if (n >= SIDEBAR_MIN_WIDTH && n <= SIDEBAR_MAX_WIDTH) setSidebarWidthState(n);
      }
    } catch {
      // locked-down storage; keep the default
    }
  }, []);
  const setSidebarWidth = (px: number) => {
    const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, px));
    setSidebarWidthState(clamped);
    try {
      localStorage.setItem('neatoRewindSidebarWidth', String(clamped));
    } catch {
      // ignore
    }
  };

  // Hotfix v3: Ctrl+B keyboard backstop for sidebar toggle. When
  // the chevron click ever fails to register (still investigating
  // the root cause; suspected hydration / event-binding race in
  // Tauri's Webview2), the user has a guaranteed escape hatch
  // that goes through the global window keydown listener instead
  // of any per-component event handler. Standard shortcut in
  // Cursor / VSCode / Notion / Slack so it should feel familiar.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && !e.shiftKey && !e.altKey) {
        // Don't fire when the user is typing in an input — Ctrl+B
        // is "bold" in textareas, and the search box would lose
        // focus from a global preventDefault.
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName ?? '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
          return;
        }
        e.preventDefault();
        setIsCollapsed((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Update current meeting when on home page
  useEffect(() => {
    if (pathname === '/') {
      setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
    }
    setSidebarItems(baseItems);
  }, [pathname]);

  // Update sidebar items when meetings, folders, or tags change.
  // Phase 3 Task 7: folders / tags now influence the items array; need
  // to re-render when either changes.
  useEffect(() => {
    setSidebarItems(baseItems);
  }, [meetings, folders, tags]);

  return (
    <SidebarContext.Provider
      value={{
        currentMeeting,
        setCurrentMeeting,
        sidebarItems,
        isCollapsed,
        toggleCollapse,
        sidebarWidth,
        setSidebarWidth,
        isResizingSidebar,
        setIsResizingSidebar,
        meetings,
        setMeetings,
        isMeetingActive,
        setIsMeetingActive,
        recorderState,
        recordingTitle,
        recordingSource,
        recordingConfidence,
        setRecordingTitle,
        // Phase 3 Task 7
        folders,
        tags,
        // Phase 3 Task 9
        savedPrompts,
        refreshSavedPrompts,
        refreshFolders,
        createFolder,
        renameFolder,
        deleteFolder,
        setFolderDefaultPrompt: setFolderDefaultPromptImpl,
        setMeetingFolder: setMeetingFolderImpl,
        addMeetingTag,
        removeMeetingTag,
        // Phase 5 Task 2
        hasSeenWelcomePanel,
        dismissWelcomePanel,
        // Phase 8 Task 9
        autoSummarizeEnabled,
        setAutoSummarizeEnabled,
        runningJobs,
        isJobRunning,
        runningJobsCount,
      }}
    >
      {children}
      {saveFailure && (
        <SaveFailedToast
          payload={saveFailure}
          onDismiss={() => setSaveFailure(null)}
        />
      )}
      {processingSave && !saveFailure && (
        <ProcessingToast
          title={processingSave.title}
          stage={processingSave.stage}
          onDismiss={() => setProcessingSave(null)}
        />
      )}
    </SidebarContext.Provider>
  );
}

// Phase 6 Task 7: in-flight transcribing/saving toast. Top-right,
// non-sticky for the "saved" stage (auto-dismisses), sticky-with-X
// during transcribing in case the upload hangs and we want the user
// to be able to clear the toast manually. Sized smaller than the
// SaveFailedToast — this one is success-path UX, not a failure.
function ProcessingToast({
  title,
  stage,
  onDismiss,
}: {
  title: string;
  stage: 'transcribing' | 'saved';
  onDismiss: () => void;
}) {
  const message =
    stage === 'transcribing'
      ? 'Transcribing & saving…'
      : 'Saved to your meetings';
  const accent =
    stage === 'transcribing'
      ? 'border-rw-border'
      : 'border-rw-success';
  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed top-12 right-6 z-[55] w-[320px] max-w-[calc(100vw-3rem)] bg-rw-card border ${accent} rounded-rw-lg shadow-rw-modal p-3`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {stage === 'transcribing' ? (
            <span
              className="inline-block w-3 h-3 rounded-full border-2 border-rw-text-tertiary border-t-rw-text-primary animate-spin"
              aria-hidden
            />
          ) : (
            <span className="inline-block w-3 h-3 rounded-full bg-rw-success" />
          )}
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-rw-text-primary truncate">
              {message}
            </div>
            <div className="text-[11px] text-rw-text-tertiary truncate">
              {title}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-rw-text-tertiary hover:text-rw-text-primary leading-none text-base"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}

// Phase 5 Task 1: sticky toast surfaced when a save flow fails after
// the user stops recording. The recovery WAV is already on disk; the
// toast's job is to point the user at it and at the recovery script.
// Top-right fixed position, doesn't auto-dismiss, can be copied from.
function SaveFailedToast({
  payload,
  onDismiss,
}: {
  payload: SaveFailedState;
  onDismiss: () => void;
}) {
  const [retrying, setRetrying] = React.useState(false);
  const [retryError, setRetryError] = React.useState<string | null>(null);

  const titleByKind: Record<string, string> = {
    transcribe: 'Transcription failed — recording saved locally.',
    'save-transcript': 'Save failed — recording saved locally.',
  };
  const title =
    titleByKind[payload.kind] ?? 'Save failed — recording saved locally.';
  const hasPath = !!payload.recovery_path;
  const recoveryCmd = hasPath
    ? `cd backend && python scripts/recover_recording.py "${payload.recovery_path}"`
    : '';

  async function copyPath() {
    if (!hasPath) return;
    try {
      await navigator.clipboard.writeText(payload.recovery_path);
    } catch {
      /* clipboard may be denied; ignore */
    }
  }
  async function copyCommand() {
    if (!recoveryCmd) return;
    try {
      await navigator.clipboard.writeText(recoveryCmd);
    } catch {
      /* ignore */
    }
  }
  async function retry() {
    if (!hasPath || retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await invoke('retry_transcription', { recoveryPath: payload.recovery_path });
      // Success — the meeting-saved event will refresh the sidebar.
      onDismiss();
    } catch (e) {
      setRetryError(String(e));
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div
      role="alert"
      className="fixed top-12 right-6 z-[60] w-[380px] max-w-[calc(100vw-3rem)] bg-rw-card border border-rw-coral rounded-rw-lg shadow-rw-modal p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-rw-coral-text text-[13px] font-medium">
          <span className="inline-block w-2 h-2 rounded-full bg-rw-coral" />
          {title}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-rw-text-tertiary hover:text-rw-text-primary leading-none text-lg"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      <p className="mt-2 text-[12px] text-rw-text-secondary leading-[1.5]">
        Your audio is safe. Recover it once the backend is back up:
      </p>
      {hasPath ? (
        <>
          <div className="mt-2 font-mono text-[11px] text-rw-text-primary bg-rw-subtle border border-rw-border rounded-rw-md px-2 py-1.5 break-all">
            {payload.recovery_path}
          </div>
          <div className="mt-2 font-mono text-[11px] text-rw-text-primary bg-rw-subtle border border-rw-border rounded-rw-md px-2 py-1.5 break-all">
            {recoveryCmd}
          </div>
          {retryError && (
            <p className="mt-2 text-[11px] text-rw-coral-text break-words">
              Retry failed: {retryError}
            </p>
          )}
          <div className="mt-3 flex gap-2 justify-end">
            <button
              type="button"
              onClick={copyPath}
              className="px-2.5 py-1 text-[11px] rounded-rw-md border border-rw-border bg-rw-card hover:bg-rw-hover text-rw-text-secondary"
            >
              Copy path
            </button>
            <button
              type="button"
              onClick={copyCommand}
              className="px-2.5 py-1 text-[11px] rounded-rw-md border border-rw-border bg-rw-card hover:bg-rw-hover text-rw-text-secondary"
            >
              Copy command
            </button>
            <button
              type="button"
              onClick={retry}
              disabled={retrying}
              className="px-2.5 py-1 text-[11px] rounded-rw-md border border-rw-coral bg-rw-coral/10 hover:bg-rw-coral/20 text-rw-coral-text disabled:opacity-50"
            >
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        </>
      ) : (
        <p className="mt-2 text-[11px] text-rw-text-tertiary">
          The recovery file could not be written either — check the
          Tauri logs.
        </p>
      )}
      {payload.error && (
        <p className="mt-3 text-[11px] text-rw-text-tertiary break-words">
          <span className="font-medium">Error:</span> {payload.error}
        </p>
      )}
    </div>
  );
}
