'use client';

import { Section as SectionType, Block } from '@/types';
import { BlockComponent } from './Block';
import { EditableTitle } from '../EditableTitle';
import { useState, useRef } from 'react';
import { motion } from 'framer-motion';

interface SectionProps {
  section: SectionType;
  sectionKey: string;
  selectedBlocks: string[];
  onBlockTypeChange: (blockId: string, type: Block['type']) => void;
  onBlockChange: (blockId: string, content: string) => void;
  onBlockMouseDown: (blockId: string, e: React.MouseEvent<HTMLDivElement>) => void;
  onBlockMouseEnter: (blockId: string) => void;
  onBlockMouseUp: (blockId: string, e: React.MouseEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent, blockId: string, newBlockContent?: string) => void;
  onTitleChange?: (sectionKey: string, title: string) => void;
  onSectionDelete?: (sectionKey: string) => void;
  onBlockDelete: (blockId: string, mergeContent?: string) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onBlockNavigate?: (blockId: string, direction: 'up' | 'down', cursorPosition: number) => void;
}

// Phase 4 Task 2: per-section accent color. Maps the canonical section
// keys produced by the Gemini summary schema (Phase 4 Task 1A) to a
// tinted square that gives each section a semantic visual hook
// (red=deadlines, green=actions, etc). Unknown keys fall back to a
// neutral subtle tint so user-added "+" sections still render cleanly.
const SECTION_ACCENT: Record<string, string> = {
  SectionSummary: 'bg-rw-info-bg',
  CriticalDeadlines: 'bg-rw-danger-bg',
  KeyItemsDecisions: 'bg-rw-warning-bg',
  ImmediateActionItems: 'bg-rw-success-bg',
  NextSteps: 'bg-rw-subtle',
  OtherImportantPoints: 'bg-rw-info-bg',
  ClosingRemarks: 'bg-rw-subtle',
  Risks: 'bg-rw-danger-bg',
};

export const Section: React.FC<SectionProps> = ({
  section,
  sectionKey,
  selectedBlocks,
  onBlockTypeChange,
  onBlockChange,
  onBlockMouseDown,
  onBlockMouseEnter,
  onBlockMouseUp,
  onKeyDown,
  onTitleChange,
  onSectionDelete,
  onBlockDelete,
  onContextMenu,
  onBlockNavigate,
}) => {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const handleTitleChange = (newTitle: string) => {
    if (onTitleChange) {
      onTitleChange(sectionKey, newTitle);
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      setIsEditingTitle(false);
    }
  };

  // Phase 4 Task 2: tinted accent square encodes section semantics
  // (Critical Deadlines→red tint, Action Items→green tint, etc.).
  const accentClass = SECTION_ACCENT[sectionKey] ?? 'bg-rw-subtle';

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="mb-5 group/section"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={`inline-block w-3.5 h-3.5 rounded-rw-sm flex-shrink-0 ${accentClass}`}
            aria-hidden
          />
          <div className="text-[12px] font-medium uppercase tracking-[0.5px] text-rw-text-secondary truncate">
            <EditableTitle
              title={section.title}
              isEditing={isEditingTitle}
              onStartEditing={() => setIsEditingTitle(true)}
              onFinishEditing={() => setIsEditingTitle(false)}
              onChange={handleTitleChange}
              onDelete={onSectionDelete ? () => onSectionDelete(sectionKey) : undefined}
            />
          </div>
        </div>
        {onSectionDelete && (
          <button
            onClick={() => onSectionDelete(sectionKey)}
            className="opacity-0 group-hover/section:opacity-100 transition-opacity text-[11px] text-rw-text-tertiary hover:text-rw-danger-text"
          >
            Delete
          </button>
        )}
      </div>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.2 }}
      >
        {section.blocks.map((block, index) => (
          <motion.div
            key={block.id}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3, delay: index * 0.1 }}
          >
            <BlockComponent
              block={block}
              isSelected={selectedBlocks.includes(block.id)}
              onTypeChange={(type) => onBlockTypeChange(block.id, type)}
              onChange={(content) => onBlockChange(block.id, content)}
              onMouseDown={(e) => onBlockMouseDown(block.id, e)}
              onMouseEnter={() => onBlockMouseEnter(block.id)}
              onMouseUp={(e) => onBlockMouseUp(block.id, e)}
              onKeyDown={(e) => {
                const newBlockContent = (e.currentTarget as HTMLTextAreaElement).dataset.newBlockContent;
                onKeyDown(e, block.id, newBlockContent);
              }}
              onDelete={() => {
                const textarea = document.querySelector(`[data-block-id="${block.id}"]`) as HTMLTextAreaElement;
                const mergeContent = textarea?.dataset.mergeContent;
                onBlockDelete(block.id, mergeContent);
              }}
              onContextMenu={onContextMenu}
              onNavigate={onBlockNavigate ? 
                (direction, cursorPosition) => onBlockNavigate(block.id, direction, cursorPosition)
                : undefined}
            />
          </motion.div>
        ))}
      </motion.div>
    </motion.div>
  );
};
