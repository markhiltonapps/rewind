'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, File, Settings, ChevronLeftCircle, ChevronRightCircle, Calendar, Home, Delete, FolderPlus, Folder as FolderIcon, Pencil, Trash2, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useSidebar } from './SidebarProvider';
import type { CurrentMeeting } from '@/components/Sidebar/SidebarProvider';
import { ConfirmationModal } from '../ConfirmationModel/confirmation-modal';
import { FolderDefaultPromptModal } from '../FolderDefaultPromptModal';

interface SidebarItem {
  id: string;
  title: string;
  // Phase 3 Task 5: 'header' is a non-interactive section label (date
  // bucket headers like "Today" / "Yesterday" / "This Week" / "Earlier"
  // in the Meetings group). Renderer special-cases it to skip click
  // handler, hover state, icon — see renderItem.
  type: 'folder' | 'file' | 'header';
  children?: SidebarItem[];
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
    isMeetingActive,
    // Phase 3 Task 7: folder CRUD from context.
    folders,
    createFolder,
    renameFolder,
    deleteFolder,
    // Phase 5 Task 2: dismiss welcome panel on meeting/intro-call clicks.
    hasSeenWelcomePanel,
    dismissWelcomePanel,
  } = useSidebar();
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
    const isDisabled = isMeetingActive && isMeetingItem;

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
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center">
                <File className={`w-4 h-4 mr-1 ${isDisabled ? 'text-gray-400' : ''}`} />
                <span className={isDisabled ? 'text-gray-400' : ''}>{item.title}</span>
              </div>
              {isMeetingItem && !isDisabled && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteModalState({ isOpen: true, itemId: item.id });
                  }}
                  className="opacity-0 group-hover:opacity-100 hover:text-red-600 p-1 rounded-md hover:bg-red-50"
                >
                  <Delete className="w-4 h-4" />
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
        onClick={toggleCollapse}
        className="fixed top-20 z-[80] p-1 bg-white hover:bg-gray-100 rounded-full shadow-lg border transition-all duration-300"
        style={{
          left: isCollapsed ? '52px' : '244px',
          // Explicitly mark as non-drag so Tauri's titlebar app-region
          // can't accidentally swallow the click.
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
        aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {isCollapsed ? (
          <ChevronRightCircle className="w-6 h-6" />
        ) : (
          <ChevronLeftCircle className="w-6 h-6" />
        )}
      </button>

      <div className="fixed top-0 left-0 h-screen z-40">
      <div
        className={`h-screen bg-rw-bg-recede border-r border-rw-border flex flex-col transition-all duration-300 ${
          isCollapsed ? 'w-16' : 'w-64'
        }`}
      >
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
            settings entry, matching meeting-row visual rhythm. */}
        {!isCollapsed && (
          <div className="p-3 border-t border-rw-border">
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
      </div>
    </>
  );
};

export default Sidebar;
