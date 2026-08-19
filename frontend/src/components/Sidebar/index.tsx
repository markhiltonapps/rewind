'use client';

import React, { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ChevronDown, ChevronRight, File, Settings, ChevronLeftCircle, ChevronRightCircle, Calendar, Home, FolderPlus, Folder as FolderIcon, Pencil, Trash2, Sparkles, Search, X, Youtube, Volume2, BarChart3 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useRouter } from 'next/navigation';
import { useSidebar } from './SidebarProvider';
import type { CurrentMeeting } from '@/components/Sidebar/SidebarProvider';
import { ConfirmationModal } from '../ConfirmationModel/confirmation-modal';
import { FolderDefaultPromptModal } from '../FolderDefaultPromptModal';
import { YoutubeImportModal } from '../YoutubeImportModal';
import { RecoveryModal } from '../RecoveryModal';
import { parseTimestamp } from '@/lib/date-buckets';
import {
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from './SidebarProvider';

interface SidebarItem {
  id: string;
  title: string;
  // Phase 3 Task 5: 'header' is a non-interactive section label (date
  // bucket headers like "Today" / "Yesterday" / "This Week" / "Earlier"
  // in the Meetings group). Renderer special-cases it to skip click
  // handler, hover state, icon — see renderItem.
  type: 'folder' | 'file' | 'header';
  children?: SidebarItem[];
  created_at?: string;
}

// Per-row date stamp. Rows already sit under a month/day header, so
// the stamp only needs enough precision to disambiguate within that
// group: time-of-day for today, weekday+time for this week, and
// day-of-month for anything older.
function formatRowDate(value: string | undefined, now: Date = new Date()): string | null {
  const d = parseTimestamp(value);
  if (!d) return null;

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeek = new Date(startOfToday);
  const dow = startOfWeek.getDay();
  startOfWeek.setDate(startOfWeek.getDate() - (dow === 0 ? 6 : dow - 1));

  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (d >= startOfToday) return time;
  if (d >= startOfYesterday) return time;
  if (d >= startOfWeek) {
    return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  }
  // Older rows live under a "Month Year" header — day number plus
  // weekday is enough, and stays narrow.
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const Sidebar: React.FC = () => {
  const router = useRouter();
  const {
    sidebarItems,
    isCollapsed,
    toggleCollapse,
    setCurrentMeeting,
    currentMeeting,
    setMeetings,
    // Phase 3 Task 7: folder CRUD from context.
    folders,
    createFolder,
    renameFolder,
    deleteFolder,
    // Phase 5 Task 2: dismiss welcome panel on meeting/intro-call clicks.
    hasSeenWelcomePanel,
    dismissWelcomePanel,
    // Phase 8 Task 9: per-row spinner for in-flight auto-summary jobs.
    isJobRunning,
    // Phase 8 Task 11: persistent REC pill in the sidebar header.
    // recorderState + recordingTitle drive what the pill displays;
    // visible from every page so the user is never unaware that
    // capture is happening while they read a past meeting or use Ask.
    recorderState,
    recordingTitle,
    sidebarWidth,
    setSidebarWidth,
    isResizingSidebar,
    setIsResizingSidebar,
  } = useSidebar();

  // Drag-to-resize. Pointer capture on the divider keeps events flowing
  // to it even when the cursor outruns the element mid-drag.
  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsResizingSidebar(true);
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizingSidebar) return;
    setSidebarWidth(e.clientX);
  };
  const onResizeEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizingSidebar) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // pointer already released
    }
    setIsResizingSidebar(false);
  };
  // Double-click the divider to snap back to the default width.
  const onResizeDoubleClick = () => setSidebarWidth(256);
  // Phase 3 Task 7: default-expand the meetings group AND every user
  // folder. The expandedFolders set tracks "explicitly toggled" state,
  // so when a folder appears for the first time we add it here.
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(['meetings'])
  );
  useEffect(() => {
    setExpandedFolders((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const f of folders) {
        if (!next.has(f.id)) {
          next.add(f.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [folders]);

  const [deleteModalState, setDeleteModalState] = useState<{ isOpen: boolean; itemId: string | null }>({ isOpen: false, itemId: null });
  // Phase 3 Task 7: + New Folder inline-create state.
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  // Phase 3 Task 7: rename-folder inline state. Stores the id of the
  // folder currently being renamed; null when no rename is active.
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Phase 3 Task 7: right-click context menu position. Closed when null.
  const [contextMenu, setContextMenu] = useState<{
    folderId: string;
    folderName: string;
    x: number;
    y: number;
  } | null>(null);
  // Folder pending deletion (separate from the meeting-delete confirm modal
  // since the messaging differs — folders uncategorize their meetings).
  const [folderDeleteId, setFolderDeleteId] = useState<string | null>(null);
  // Phase 3 Task 9: folder whose default-prompt assignment is being
  // edited via the modal opened from the context menu's "Default
  // prompt..." entry. null = closed.
  const [defaultPromptFolderId, setDefaultPromptFolderId] = useState<string | null>(null);
  // Phase 6 Task 4: YouTube import modal toggle.
  const [youtubeImportOpen, setYoutubeImportOpen] = useState(false);
  // Recovery modal toggle + pending count badge.
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryCount, setRecoveryCount] = useState(0);
  const refreshRecoveryCount = () => {
    invoke<{ path: string }[]>('list_recovery_files')
      .then((files) => setRecoveryCount(files.length))
      .catch(() => {});
  };
  useEffect(() => { refreshRecoveryCount(); }, []);
  // Phase 6 Task 1: global search input. Debounced 200ms before
  // pushing to /search?q= so a fast typist doesn't fire the route
  // change on every keystroke. Clearing the input while on /search
  // navigates back to /.
  const [searchQuery, setSearchQuery] = useState('');
  const pathname = usePathname();

  // Phase 8 Task 7: hidden Admin entry. Default off — testers never
  // see Admin. Mark toggles visibility with Ctrl+Shift+A, persisted
  // in localStorage so it survives restarts. Defense in depth, not
  // a real ACL — anyone with DevTools could flip the flag — but
  // sufficient for a closed beta.
  const [adminVisible, setAdminVisible] = useState(false);
  useEffect(() => {
    try {
      setAdminVisible(localStorage.getItem('neatoRewindAdminVisible') === 'true');
    } catch {
      // SSR / locked-down storage. Stay hidden.
    }
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        setAdminVisible((prev) => {
          const next = !prev;
          try {
            localStorage.setItem('neatoRewindAdminVisible', next ? 'true' : 'false');
          } catch {
            // ignore — runtime state still updates
          }
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Phase 8 Task 11: track Recording-state entry timestamp so the
  // persistent REC pill can render elapsed time. Captured the moment
  // recorderState transitions INTO Recording — not on every render —
  // so a re-render mid-session doesn't reset the counter. Cleared on
  // Idle so a fresh session starts fresh.
  const [recStartedAt, setRecStartedAt] = useState<number | null>(null);
  const [recElapsed, setRecElapsed] = useState('00:00');
  useEffect(() => {
    if (recorderState === 'Recording') {
      // Functional setState — only seed if we don't already have a
      // timestamp (defensive against the Recording → Finalizing →
      // Recording flicker the manual-stop-then-keep-going branch can
      // produce).
      setRecStartedAt((prev) => prev ?? Date.now());
    } else if (recorderState === 'Idle') {
      setRecStartedAt(null);
      setRecElapsed('00:00');
    }
  }, [recorderState]);
  useEffect(() => {
    if (!recStartedAt) return;
    const tick = () => {
      const secs = Math.floor((Date.now() - recStartedAt) / 1000);
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      setRecElapsed(`${mm}:${ss}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [recStartedAt]);
  const isCapturing = recorderState === 'Recording' || recorderState === 'Finalizing';

  useEffect(() => {
    const trimmed = searchQuery.trim();
    const onSearchPage = pathname === '/search';
    if (!trimmed) {
      // If the user clears the input while on /search, route back
      // home. Otherwise leave the current page alone — they may
      // have typed and deleted before navigating.
      if (onSearchPage) {
        const t = setTimeout(() => router.push('/'), 100);
        return () => clearTimeout(t);
      }
      return;
    }
    const t = setTimeout(() => {
      router.push(`/search?q=${encodeURIComponent(trimmed)}`);
    }, 200);
    return () => clearTimeout(t);
  }, [searchQuery, pathname, router]);

  // Close context menu on any click outside it.
  useEffect(() => {
    if (!contextMenu) return;
    const onClickAway = () => setContextMenu(null);
    window.addEventListener('click', onClickAway);
    window.addEventListener('contextmenu', onClickAway);
    return () => {
      window.removeEventListener('click', onClickAway);
      window.removeEventListener('contextmenu', onClickAway);
    };
  }, [contextMenu]);

  const submitNewFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      setCreatingFolder(false);
      setNewFolderName('');
      return;
    }
    const folder = await createFolder(trimmed);
    setCreatingFolder(false);
    setNewFolderName('');
    if (folder) {
      // Default-expand the new folder.
      setExpandedFolders((prev) => new Set(prev).add(folder.id));
    }
  };

  const submitRename = async () => {
    if (!renamingFolderId) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingFolderId(null);
      setRenameValue('');
      return;
    }
    await renameFolder(renamingFolderId, trimmed);
    setRenamingFolderId(null);
    setRenameValue('');
  };


  const handleDelete = async (itemId: string) => {
    console.log('Deleting item:', itemId);
    const payload = {
      meeting_id: itemId
    };
    const response = await fetch('http://localhost:5167/delete-meeting', {
      cache: 'no-store',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      console.log('Meeting deleted successfully');
      setMeetings((prev: CurrentMeeting[]) => prev.filter(m => m.id !== itemId));
      
      // If deleting the active meeting, navigate to home
      if (currentMeeting?.id === itemId) {
        setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
        router.push('/');
      }
    } else {
      console.error('Failed to delete meeting');
    }
  };

  const toggleFolder = (folderId: string) => {
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(folderId)) {
      newExpanded.delete(folderId);
    } else {
      newExpanded.add(folderId);
    }
    setExpandedFolders(newExpanded);
  };

  const renderCollapsedIcons = () => {
    if (!isCollapsed) return null;

    return (
      <div className="flex flex-col items-center space-y-4 mt-4">
        {/* <button
          onClick={() => router.push('/')}
          className="p-2 hover:bg-gray-100 rounded-md transition-colors"
          title="Home"
        >
          <Home className="w-5 h-5 text-gray-600" />
        </button> */}
        <button
          onClick={() => {
            if (isCollapsed) toggleCollapse();
            toggleFolder('meetings');
          }}
          className="p-2 hover:bg-gray-100 rounded-md transition-colors"
          title="Meetings"
        >
          <Calendar className="w-5 h-5 text-gray-600" />
        </button>
      </div>
    );
  };

  const renderItem = (item: SidebarItem, depth = 0) => {
    const isExpanded = expandedFolders.has(item.id);
    const paddingLeft = `${depth * 12 + 12}px`;
    const isActive = item.type === 'file' && currentMeeting?.id === item.id;
    const isMeetingItem = item.id.includes('-') && !item.id.startsWith('intro-call');
    const rowDate = isMeetingItem ? formatRowDate(item.created_at) : null;
    // Phase 8 Task 11: past meetings are clickable during recording so
    // the user can read or Ask while a new meeting captures in the
    // background. Recording capture runs in Rust and is unaffected by
    // routing — the persistent sidebar-header REC pill (added below)
    // is the always-on cue that recording is in progress.
    const isDisabled = false;

    if (isCollapsed) return null;

    // Phase 3 Task 5: non-interactive section header for date-bucket
    // labels. Phase 4 Task 2 visual: micro-cap label, tertiary text
    // color, comfortable top spacing so the buckets read as separate
    // groups rather than blending into the meeting list.
    if (item.type === 'header') {
      return (
        <div
          key={item.id}
          className="text-[11px] font-medium tracking-[0.5px] uppercase text-rw-text-tertiary select-none pt-4 pb-1"
          style={{ paddingLeft }}
        >
          {item.title}
        </div>
      );
    }

    // Phase 3 Task 7: + New Folder action. Sentinel id triggered by
    // SidebarProvider's baseItems construction. Click → inline input
    // for the folder name. Enter creates, Escape / blur cancels.
    if (item.id === '__new_folder__') {
      if (creatingFolder) {
        return (
          <div
            key={item.id}
            className="flex items-center px-2 py-1 text-sm"
            style={{ paddingLeft }}
          >
            <FolderPlus className="w-4 h-4 mr-1 text-gray-500" />
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onBlur={submitNewFolder}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitNewFolder();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setCreatingFolder(false);
                  setNewFolderName('');
                }
              }}
              placeholder="Folder name"
              maxLength={100}
              className="flex-1 bg-transparent border-b border-blue-400 outline-none text-sm"
            />
          </div>
        );
      }
      return (
        <div
          key={item.id}
          className="flex items-center px-2 py-1 text-sm cursor-pointer hover:bg-gray-100 text-gray-600"
          style={{ paddingLeft }}
          onClick={() => {
            setCreatingFolder(true);
            setNewFolderName('');
          }}
        >
          <FolderPlus className="w-4 h-4 mr-1" />
          <span>+ New Folder</span>
        </div>
      );
    }

    // Phase 6 Task 4: YouTube import sentinel — opens the
    // YoutubeImportModal instead of navigating.
    if (item.id === '__youtube_import__') {
      return (
        <div
          key={item.id}
          className="flex items-center px-2 py-1 text-sm cursor-pointer hover:bg-gray-100 text-gray-600"
          style={{ paddingLeft }}
          onClick={() => setYoutubeImportOpen(true)}
        >
          <Youtube className="w-4 h-4 mr-1 text-rw-coral" />
          <span>+ YouTube video</span>
        </div>
      );
    }

    // Phase 6 Task 4 (Option 1): system-audio recording sentinel.
    // Triggers manual_start_system_audio_only on the Rust side and
    // routes to '/' so the user sees the active-recording UI. The
    // existing Stop button on the home page calls manual_stop /
    // stop_recording as it does for normal manual recordings — no
    // separate stop UI needed because the SYSTEM_AUDIO_ONLY flag
    // gets cleared automatically when the WAV finishes encoding.
    if (item.id === '__system_audio_record__') {
      return (
        <div
          key={item.id}
          className="flex items-center px-2 py-1 text-sm cursor-pointer hover:bg-gray-100 text-gray-600"
          style={{ paddingLeft }}
          title="Record any browser audio (Loom, Vimeo, podcasts). Mic input is dropped — only system speaker audio is captured."
          onClick={async () => {
            try {
              await invoke('manual_start_system_audio_only');
              router.push('/');
            } catch (err) {
              console.error('manual_start_system_audio_only failed', err);
            }
          }}
        >
          <Volume2 className="w-4 h-4 mr-1 text-rw-primary" />
          <span>+ Browser audio</span>
        </div>
      );
    }

    // Phase 3 Task 7: a USER folder being renamed (id matches a row in
    // the `folders` context state, not the top-level "meetings" group
    // and not '__new_folder__'). Inline input, Enter commits, Escape
    // cancels.
    const isUserFolder =
      item.type === 'folder' &&
      item.id !== 'meetings' &&
      folders.some((f) => f.id === item.id);
    if (isUserFolder && renamingFolderId === item.id) {
      return (
        <div
          key={item.id}
          className="flex items-center px-2 py-1 text-sm"
          style={{ paddingLeft }}
        >
          <FolderIcon className="w-4 h-4 mr-1 text-gray-500" />
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setRenamingFolderId(null);
                setRenameValue('');
              }
            }}
            maxLength={100}
            className="flex-1 bg-transparent border-b border-blue-400 outline-none text-sm"
          />
        </div>
      );
    }

    return (
      <div key={item.id}>
        <div
          className={`flex items-center px-2 py-1.5 mx-1.5 my-0.5 rounded-rw-md text-[13px] group transition-colors ${
            isActive
              ? // Phase 4 Task 2.5: active item is a white card sitting
                // on the cream-recede sidebar — depth via lightness, not
                // tinted accent. Border picks up the shared rw-border.
                'bg-rw-card text-rw-text-primary font-medium border border-rw-border'
              : 'hover:bg-rw-hover text-rw-text-primary'
          } ${
            isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
          }`}
          style={{ paddingLeft }}
          onClick={() => {
            if (item.type === 'folder') {
              toggleFolder(item.id);
            } else {
              // Prevent navigation to meeting-details if a meeting is active
              if (isDisabled) {
                return;
              }

              setCurrentMeeting({ id: item.id, title: item.title });
              // Phase 5 Task 2: dismiss the welcome panel as soon as
              // the user engages with any meeting or the +New Call
              // entry — covers the "click sample meeting" and "click
              // +New Call" dismissal paths from the spec. The
              // __new_folder__ sentinel is filtered out by the file/
              // folder type check above (it has type 'file' but a
              // dedicated branch elsewhere).
              if (hasSeenWelcomePanel === false) {
                dismissWelcomePanel();
              }
              // Phase 3 Task 2: dropped the dead `/notes/${item.id}` arm.
              // The Notes group with project-ideas / action-items stubs
              // is gone; saved meetings route to /meeting-details, the
              // intro-call action button routes to /. Nothing routes
              // anywhere else.
              const basePath = item.id.startsWith('intro-call')
                ? '/'
                : '/meeting-details';
              router.push(basePath);
            }
          }}
          // Phase 3 Task 7: right-click on a USER folder opens the
          // rename/delete context menu. Skipped for the top-level
          // "meetings" group folder.
          onContextMenu={
            isUserFolder
              ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({
                    folderId: item.id,
                    folderName: item.title,
                    x: e.clientX,
                    y: e.clientY,
                  });
                }
              : undefined
          }
        >
          {item.type === 'folder' ? (
            <>
              {item.id === 'meetings' ? (
                <Calendar className="w-4 h-4 mr-2" />
              ) : isUserFolder ? (
                <FolderIcon className="w-4 h-4 mr-2 text-gray-500" />
              ) : null}
              {isExpanded ? (
                <ChevronDown className="w-4 h-4 mr-1" />
              ) : (
                <ChevronRight className="w-4 h-4 mr-1" />
              )}
              {item.title}
            </>
          ) : (
            <div className="flex items-center justify-between w-full gap-1.5 min-w-0">
              <div className="flex items-center min-w-0 flex-1">
                <File className={`w-4 h-4 mr-1 flex-shrink-0 ${isDisabled ? 'text-gray-400' : ''}`} />
                <span className={`truncate ${isDisabled ? 'text-gray-400' : ''}`}>{item.title}</span>
                {/* Phase 8 Task 9: small spinner while an auto-summary
                    job is in flight for this meeting. Visible at all
                    times (not gated on hover) so the user can see
                    background work happening from any sidebar state. */}
                {isMeetingItem && isJobRunning(item.id) && (
                  <span
                    className="ml-1.5 inline-block w-3 h-3 rounded-full border-2 border-rw-text-tertiary border-t-rw-primary animate-spin flex-shrink-0"
                    title="Summarizing in background…"
                    aria-label="Summarizing in background"
                  />
                )}
              </div>
              {/* Date stamp. Hidden on hover so the delete button can
                  take its place without shifting the title. */}
              {rowDate && (
                <span className="font-mono text-[10px] text-rw-text-tertiary flex-shrink-0 tabular-nums group-hover:hidden">
                  {rowDate}
                </span>
              )}
              {isMeetingItem && !isDisabled && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteModalState({ isOpen: true, itemId: item.id });
                  }}
                  className="hidden group-hover:block hover:text-red-600 p-1 rounded-md hover:bg-red-50 flex-shrink-0"
                  title="Delete meeting"
                  aria-label="Delete meeting"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          )}
        </div>
        {item.type === 'folder' && isExpanded && item.children && (
          <div>
            {/* Phase 5 Task 2: empty-folder hint. Renders inside an
                expanded user folder (NOT the top-level "meetings"
                group) when no meetings have been assigned. Mentions
                the folder's default prompt if one is set, surfacing
                the value of Phase 3 Task 9's folder-defaults feature
                even before there are meetings. */}
            {item.id !== 'meetings' &&
              item.children.length === 0 &&
              (() => {
                const folder = folders.find((f) => f.id === item.id);
                const defaultPromptName = folder?.default_prompt_name ?? null;
                return (
                  <div
                    className="text-[12px] text-rw-text-tertiary py-1.5 italic"
                    style={{ paddingLeft: `${(depth + 1) * 12 + 12}px` }}
                  >
                    {defaultPromptName
                      ? `No meetings yet — uses ${defaultPromptName}`
                      : 'No meetings yet'}
                  </div>
                );
              })()}
            {item.children.map(child => renderItem(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Floating collapse button.
          Hotfix: lifted OUT of the sidebar's z-40 fixed wrapper to a
          top-level fixed position with z-[80]. Earlier the button was
          a child of the sidebar's wrapper and inherited its stacking
          context — when any descendant of MainContent (Onboarding
          modal, recovery toast, etc.) created a higher local z, the
          chevron became unclickable even though it was visible. The
          left position tracks the sidebar width: 64px (w-16) when
          collapsed, 256px (w-64) when expanded; pulled back 12px so
          the button straddles the border like before. */}
      <button
        type="button"
        // Hotfix v3: respond to pointerdown AND click. The pointerdown
        // path fires earlier in the input event lifecycle and isn't
        // affected by the same things that can swallow click events
        // (e.g. ancestor focus changes, hydration timing windows in
        // dev). e.preventDefault on pointerdown stops the browser
        // from also synthesising a click that'd toggle a second
        // time. cursor-pointer + active:scale-95 give the user
        // immediate visual confirmation the press registered.
        onPointerDown={(e) => {
          e.preventDefault();
          toggleCollapse();
        }}
        onClick={(e) => {
          // Belt-and-suspenders: if pointerdown didn't fire (e.g.,
          // touch passthrough, accessibility tools triggering click
          // directly), fall through to onClick. The functional
          // setState in toggleCollapse is idempotent for the
          // double-fire case where both events somehow trigger.
          e.preventDefault();
          toggleCollapse();
        }}
        className={`fixed top-20 z-[100] p-1 bg-white hover:bg-gray-100 active:scale-95 rounded-full shadow-lg border cursor-pointer ${
          isResizingSidebar ? '' : 'transition-all duration-300'
        }`}
        style={{
          left: isCollapsed ? 52 : sidebarWidth - 12,
          // Explicitly mark as non-drag so Tauri's titlebar app-region
          // can't accidentally swallow the click.
          WebkitAppRegion: 'no-drag',
          // Defensive: ensure pointer-events is auto regardless of
          // any inherited 'none' from a parent stacking context.
          pointerEvents: 'auto',
        } as React.CSSProperties}
        aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={`${isCollapsed ? 'Expand' : 'Collapse'} sidebar (Ctrl+B)`}
      >
        {isCollapsed ? (
          <ChevronRightCircle className="w-6 h-6" />
        ) : (
          <ChevronLeftCircle className="w-6 h-6" />
        )}
      </button>

      <div className="fixed top-0 left-0 h-screen z-40">
      <div
        className={`h-screen bg-rw-bg-recede border-r border-rw-border flex flex-col relative ${
          isResizingSidebar ? '' : 'transition-all duration-300'
        }`}
        style={{ width: isCollapsed ? 64 : sidebarWidth }}
      >
        {/* Drag-to-resize divider. Sits on the right edge; only active
            when expanded. The visible hairline is 1px but the grab
            target is 5px wide so it's comfortable to hit. */}
        {!isCollapsed && (
          <div
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
            onDoubleClick={onResizeDoubleClick}
            className="absolute top-0 right-0 h-full w-[5px] translate-x-[2px] cursor-col-resize z-50 group"
            title="Drag to resize · double-click to reset"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
          >
            <div
              className={`h-full w-[2px] mx-auto transition-colors ${
                isResizingSidebar
                  ? 'bg-rw-primary'
                  : 'bg-transparent group-hover:bg-rw-border-strong'
              }`}
            />
          </div>
        )}
        {/* Header with traffic-light spacing. Phase 4 Task 2.5: monospace
            NEATO_REWIND wordmark — single signature brand moment at the
            top of every screen. */}
        <div className="h-16 flex items-center border-b border-rw-border">
          <div className="w-20 h-16" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
          <div className="flex-1">
            {!isCollapsed && (
              <h1 className="font-mono text-[14px] font-medium tracking-[0.5px] text-rw-text-primary">
                NEATO_REWIND
              </h1>
            )}
          </div>
        </div>

        {/* Phase 8 Task 11: persistent REC pill. Renders on EVERY page
            when recording is active, since the sidebar wraps the whole
            app. Click → routes to Home so the user can see the live
            transcript. In collapsed mode we still show a small dot so
            the user can never be unaware that capture is in flight. */}
        {isCapturing && !isCollapsed && (
          <button
            type="button"
            onClick={() => router.push('/')}
            title="Back to live transcript"
            className="mx-3 mt-2 flex items-center gap-2 px-3 py-1.5 rounded-rw-md bg-rw-coral-bg text-rw-coral-text border border-rw-coral/30 hover:border-rw-coral transition-colors text-left"
          >
            <span className="h-2 w-2 rounded-full bg-rw-coral rw-rec-dot flex-shrink-0" />
            <div className="flex flex-col min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[11px] font-medium tracking-[0.5px]">
                  {recorderState === 'Finalizing' ? 'STOPPING' : 'REC'}
                </span>
                <span className="font-mono text-[11px] text-rw-coral-text/80">
                  {recElapsed}
                </span>
              </div>
              {recordingTitle && (
                <span className="text-[11px] text-rw-coral-text/80 truncate">
                  {recordingTitle}
                </span>
              )}
            </div>
          </button>
        )}
        {isCapturing && isCollapsed && (
          <button
            type="button"
            onClick={() => router.push('/')}
            title={`Recording: ${recordingTitle ?? 'meeting'}`}
            className="mx-auto mt-2 flex items-center justify-center w-10 h-10 rounded-full bg-rw-coral-bg border border-rw-coral hover:scale-105 transition-transform"
            aria-label="Back to live transcript"
          >
            <span className="h-3 w-3 rounded-full bg-rw-coral rw-rec-dot" />
          </button>
        )}

        {/* Phase 6 Task 1: global search. Hidden when sidebar is
            collapsed (chevron toggle expands it). Debounced
            navigation to /search?q=… handled by the useEffect on
            searchQuery above. */}
        {!isCollapsed && (
          <div className="px-3 py-2 border-b border-rw-border">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-rw-text-tertiary pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search meetings…"
                className="w-full pl-7 pr-7 py-1.5 text-[12px] bg-rw-card border border-rw-border rounded-rw-md text-rw-text-primary placeholder:text-rw-text-tertiary focus:outline-none focus:ring-2 focus:ring-rw-primary-bg focus:border-rw-primary"
                aria-label="Search meetings"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-rw-text-tertiary hover:text-rw-text-primary"
                  aria-label="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Main content */}
        <div className="flex-1 overflow-y-auto">
          {/* {!isCollapsed && (
            <div className="p-2">
              <button
                onClick={() => router.push('/')}
                className="w-full flex items-center px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
              >
                <Home className="w-4 h-4 mr-2" />
                <span>Home</span>
              </button>
            </div>
          )} */}
          {renderCollapsedIcons()}
          {sidebarItems.map(item => renderItem(item))}
        </div>

        {/* Footer. Phase 4 Task 2: subtle border-top separator over the
            settings entry, matching meeting-row visual rhythm.
            Phase 6 Task 2: Calendar entry sits above Settings. */}
        {!isCollapsed && (
          <div className="p-3 border-t border-rw-border space-y-0.5">
            {/* Phase 7 Task 2: Ask sits above Calendar — it's the
                feature most users will reach for daily once they have
                a corpus, so it earns the highest footer slot. */}
            <button
              onClick={() => router.push('/ask')}
              className="w-full flex items-center px-3 py-2 text-[13px] text-rw-text-secondary hover:bg-rw-hover hover:text-rw-text-primary rounded-rw-md transition-colors"
            >
              <Sparkles className="w-4 h-4 mr-3" />
              <span>Ask</span>
            </button>
            <button
              onClick={() => router.push('/calendar')}
              className="w-full flex items-center px-3 py-2 text-[13px] text-rw-text-secondary hover:bg-rw-hover hover:text-rw-text-primary rounded-rw-md transition-colors"
            >
              <Calendar className="w-4 h-4 mr-3" />
              <span>Calendar</span>
            </button>
            {adminVisible && (
              <button
                onClick={() => router.push('/admin/costs')}
                className="w-full flex items-center px-3 py-2 text-[13px] text-rw-text-secondary hover:bg-rw-hover hover:text-rw-text-primary rounded-rw-md transition-colors"
              >
                <BarChart3 className="w-4 h-4 mr-3" />
                <span>Admin</span>
              </button>
            )}
            {recoveryCount > 0 && (
              <button
                onClick={() => setRecoveryOpen(true)}
                className="w-full flex items-center px-3 py-2 text-[13px] text-amber-600 hover:bg-amber-50 rounded-rw-md transition-colors"
              >
                <span className="w-4 h-4 mr-3 flex items-center justify-center text-xs font-bold bg-amber-500 text-white rounded-full leading-none">
                  {recoveryCount > 9 ? '9+' : recoveryCount}
                </span>
                <span>Pending Recoveries</span>
              </button>
            )}
            <button
              onClick={() => router.push('/settings')}
              className="w-full flex items-center px-3 py-2 text-[13px] text-rw-text-secondary hover:bg-rw-hover hover:text-rw-text-primary rounded-rw-md transition-colors"
            >
              <Settings className="w-4 h-4 mr-3" />
              <span>Settings</span>
            </button>
          </div>
        )}
      </div>

      <ConfirmationModal
        isOpen={deleteModalState.isOpen}
        onConfirm={() => {
          if (deleteModalState.itemId) {
            handleDelete(deleteModalState.itemId);
          }
          setDeleteModalState({ isOpen: false, itemId: null });
        }}
        onCancel={() => setDeleteModalState({ isOpen: false, itemId: null })}
        text="Are you sure you want to delete this meeting? This action cannot be undone."
      />

      {/* Phase 3 Task 7: folder-delete confirmation. Distinct messaging
          from the meeting-delete modal because deleting a folder
          uncategorizes its meetings rather than deleting them. */}
      <ConfirmationModal
        isOpen={folderDeleteId !== null}
        onConfirm={async () => {
          if (folderDeleteId) await deleteFolder(folderDeleteId);
          setFolderDeleteId(null);
        }}
        onCancel={() => setFolderDeleteId(null)}
        text="Delete this folder? Meetings inside will move back to the date list — they won't be deleted."
      />

      {/* Phase 3 Task 7: right-click context menu for user folders. */}
      {contextMenu && (
        <div
          className="fixed bg-white border border-gray-200 rounded-md shadow-lg z-50 py-1 min-w-[140px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-100"
            onClick={() => {
              setRenamingFolderId(contextMenu.folderId);
              setRenameValue(contextMenu.folderName);
              setContextMenu(null);
            }}
          >
            <Pencil className="w-4 h-4" />
            <span>Rename</span>
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-100"
            onClick={() => {
              setDefaultPromptFolderId(contextMenu.folderId);
              setContextMenu(null);
            }}
          >
            <Sparkles className="w-4 h-4" />
            <span>Default prompt&hellip;</span>
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-red-50 text-red-600"
            onClick={() => {
              setFolderDeleteId(contextMenu.folderId);
              setContextMenu(null);
            }}
          >
            <Trash2 className="w-4 h-4" />
            <span>Delete</span>
          </button>
        </div>
      )}

      {/* Phase 3 Task 9: folder default-prompt edit modal. Pulled
          off the context menu's "Default prompt..." entry. */}
      {defaultPromptFolderId &&
        (() => {
          const folder = folders.find((f) => f.id === defaultPromptFolderId);
          if (!folder) return null;
          return (
            <FolderDefaultPromptModal
              folder={folder}
              open={true}
              onClose={() => setDefaultPromptFolderId(null)}
            />
          );
        })()}

      {/* Phase 6 Task 4: YouTube import modal. */}
      <YoutubeImportModal
        open={youtubeImportOpen}
        onClose={() => setYoutubeImportOpen(false)}
      />

      {recoveryOpen && (
        <RecoveryModal
          onClose={() => {
            setRecoveryOpen(false);
            refreshRecoveryCount();
          }}
          onRecovered={() => {
            setRecoveryCount((c) => Math.max(0, c - 1));
            refreshRecoveryCount();
          }}
        />
      )}
      </div>
    </>
  );
};

export default Sidebar;
