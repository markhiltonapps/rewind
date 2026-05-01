'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';


interface SidebarItem {
  id: string;
  title: string;
  type: 'folder' | 'file';
  children?: SidebarItem[];
}

export interface CurrentMeeting {
  id: string;
  title: string;
}

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

  useEffect(() => {
    const fetchMeetings = async () => {
      try {
        const response = await fetch('http://localhost:5167/get-meetings', {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          }
        });
        const data = await response.json();
        // Transform the response into the expected format
        const transformedMeetings = data.map((meeting: any) => ({
          id: meeting.id,
          title: meeting.title
        }));
        setMeetings(transformedMeetings);
        router.push('/')
      } catch (error) {
        console.error('Error fetching meetings:', error);
        setMeetings([]);
      }
    };
    fetchMeetings();
  }, []);

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
        setMeetings((prev) => [{ id: meeting_id, title }, ...prev]);
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
    })();

    return () => {
      cancelled = true;
      if (unlistenState) unlistenState();
      if (unlistenStarted) unlistenStarted();
      if (unlistenSaved) unlistenSaved();
      if (unlistenSaveFailed) unlistenSaveFailed();
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

  const baseItems: SidebarItem[] = [
    {
      id: 'meetings',
      title: 'Meetings',
      type: 'folder' as const,
      children: [
        { id: 'intro-call', title: '+ New Call', type: 'file' as const },
        ...filteredMeetings.map(meeting => ({ id: meeting.id, title: meeting.title, type: 'file' as const }))
      ]
    },
    {
      id: 'notes',
      title: 'Notes',
      type: 'folder' as const,
      children: [
        { id: 'project-ideas', title: 'Project Ideas', type: 'file' as const },
        { id: 'action-items', title: 'Action Items', type: 'file' as const },
      ]
    }
  ];



  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
  };

  // Update current meeting when on home page
  useEffect(() => {
    if (pathname === '/') {
      setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
    }
    setSidebarItems(baseItems);
  }, [pathname]);

  // Update sidebar items when meetings change
  useEffect(() => {
    setSidebarItems(baseItems);
  }, [meetings]);

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
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
}
