'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import {
  bucketMeetings,
  DATE_BUCKET_LABELS,
  DATE_BUCKET_ORDER,
} from '@/lib/date-buckets';


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

interface SidebarContextType {
  currentMeeting: CurrentMeeting | null;
  setCurrentMeeting: (meeting: CurrentMeeting | null) => void;
  sidebarItems: SidebarItem[];
  isCollapsed: boolean;
  toggleCollapse: () => void;
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
  addMeetingTag: (
    meeting_id: string,
    tag: { id?: string; name?: string }
  ) => Promise<TagSummary[] | null>;
  removeMeetingTag: (meeting_id: string, tag_id: string) => Promise<boolean>;
}

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
        // Phase 2b round 8: an auto-detected session starting while
        // the user is on /meeting-details, /notes, or any non-Home
        // route would otherwise leave them looking at unrelated
        // content while the live recording UI sits on Home unseen.
        // Force them to Home so they can see what's being captured.
        // Manual sessions are excluded — the click that started them
        // was already on Home, so a router.push would be pointless
        // (and would jolt the focus).
        if (!event.payload.is_manual) {
          router.push('/');
        }
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
        const { meeting_id, title, is_manual } = event.payload;
        // Phase 3 Task 5: stamp the optimistic insert with the
        // current local time so it lands in the "Today" bucket
        // immediately. The next /get-meetings refresh will replace
        // this with the canonical backend timestamp.
        setMeetings((prev) => [
          { id: meeting_id, title, created_at: new Date().toISOString() },
          ...prev,
        ]);
        if (is_manual) {
          setCurrentMeeting({ id: meeting_id, title });
          router.push('/meeting-details');
        }
      });

      unlistenSaveFailed = await attachListener<{
        meeting_id: string;
        error: string;
      }>('meeting-save-failed', (event) => {
        console.error('[Phase2b r6] meeting-save-failed:', event.payload);
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
        },
      );
    })();

    return () => {
      cancelled = true;
      if (unlistenState) unlistenState();
      if (unlistenStarted) unlistenStarted();
      if (unlistenSaved) unlistenSaved();
      if (unlistenSaveFailed) unlistenSaveFailed();
      if (unlistenSaveFailedV2) unlistenSaveFailedV2();
    };
  }, [router]);

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
      })),
    });
  }

  // Date-bucket only the uncategorized meetings (folder_id null/missing).
  const uncategorized = filteredMeetings.filter(
    (m) => !m.folder_id
  );
  const buckets = bucketMeetings(uncategorized);
  for (const bucketKey of DATE_BUCKET_ORDER) {
    const bucketEntries = buckets[bucketKey];
    if (bucketEntries.length === 0) continue;
    meetingsChildren.push({
      id: `__header_${bucketKey}__`,
      title: DATE_BUCKET_LABELS[bucketKey],
      type: 'header' as const,
    });
    for (const meeting of bucketEntries) {
      meetingsChildren.push({
        id: meeting.id,
        title: meeting.title,
        type: 'file' as const,
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
      }}
    >
      {children}
      {saveFailure && (
        <SaveFailedToast
          payload={saveFailure}
          onDismiss={() => setSaveFailure(null)}
        />
      )}
    </SidebarContext.Provider>
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
