'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, File, Settings, ChevronLeftCircle, ChevronRightCircle, Calendar, Home, Delete } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useSidebar } from './SidebarProvider';
import type { CurrentMeeting } from '@/components/Sidebar/SidebarProvider';
import { ConfirmationModal } from '../ConfirmationModel/confirmation-modal';

interface SidebarItem {
  id: string;
  title: string;
  type: 'folder' | 'file';
  children?: SidebarItem[];
}

const Sidebar: React.FC = () => {
  const router = useRouter();
  const { sidebarItems, isCollapsed, toggleCollapse, setCurrentMeeting, currentMeeting, setMeetings, isMeetingActive } = useSidebar();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['meetings']));
  const [deleteModalState, setDeleteModalState] = useState<{ isOpen: boolean; itemId: string | null }>({ isOpen: false, itemId: null });


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

    return (
      <div key={item.id}>
        <div
          className={`flex items-center px-2 py-1 hover:bg-gray-100 text-sm group ${
            isActive ? 'bg-gray-100 font-medium' : ''
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
        >
          {item.type === 'folder' ? (
            <>
              {item.id === 'meetings' ? (
                <Calendar className="w-4 h-4 mr-2" />
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
            {item.children.map(child => renderItem(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed top-0 left-0 h-screen z-40">
      {/* Floating collapse button */}
      <button
        onClick={toggleCollapse}
        className="absolute -right-6 top-20 z-50 p-1 bg-white hover:bg-gray-100 rounded-full shadow-lg border"
        style={{ transform: 'translateX(50%)' }}
      >
        {isCollapsed ? (
          <ChevronRightCircle className="w-6 h-6" />
        ) : (
          <ChevronLeftCircle className="w-6 h-6" />
        )}
      </button>

      <div 
        className={`h-screen bg-white border-r flex flex-col transition-all duration-300 ${
          isCollapsed ? 'w-16' : 'w-64'
        }`}
      >
        {/* Header with traffic light spacing */}
        <div className="h-16 flex items-center border-b">
          {/* Traffic light spacing */}
          <div className="w-20 h-16" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
          
          {/* Title container */}
          <div className="flex-1">
            {!isCollapsed && (
              <h1 className="font-semibold text-sm">Neato Rewind</h1>
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

        {/* Footer */}
        {!isCollapsed && (
          <div className="p-4 border-t">
            <button 
              onClick={() => router.push('/settings')}
              className="w-full flex items-center px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
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
    </div>
  );
};

export default Sidebar;
