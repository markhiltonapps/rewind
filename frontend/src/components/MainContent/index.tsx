'use client';

import React from 'react';
import {
  useSidebar,
  SIDEBAR_COLLAPSED_WIDTH,
} from '@/components/Sidebar/SidebarProvider';

interface MainContentProps {
  children: React.ReactNode;
}

const MainContent: React.FC<MainContentProps> = ({ children }) => {
  const { isCollapsed, sidebarWidth, isResizingSidebar } = useSidebar();

  return (
    <main
      // No width transition while dragging — the 300ms ease would make
      // the content lag behind the divider.
      className={`flex-1 ${isResizingSidebar ? '' : 'transition-all duration-300'}`}
      style={{ marginLeft: isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth }}
    >
      <div className="pl-8">
        {children}
      </div>
    </main>
  );
};

export default MainContent;
