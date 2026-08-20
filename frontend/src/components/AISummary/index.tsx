'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Summary, Block } from '@/types';
import { Section } from './Section';
import { EditableTitle } from '../EditableTitle';
import { ExclamationTriangleIcon, CheckCircleIcon, ClipboardDocumentCheckIcon } from '@heroicons/react/24/outline';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { downloadDir } from '@tauri-apps/api/path';
import { SummaryReport } from './SummaryReport';
import { summaryHtmlDocument, summaryHtmlFragment } from './summaryToHtml';

interface Props {
  summary: Summary | null;
  status: 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';
  error: string | null;
  onSummaryChange: (summary: Summary) => void;
  onRegenerateSummary: () => void;
  meeting?: {
    id: string;
    title: string;
    created_at: string;
  };
}

export const AISummary = ({
  summary,
  status,
  error,
  onSummaryChange: onSummaryChangeProp,
  onRegenerateSummary,
  meeting,
}: Props) => {
  // Report is the default: reading a summary is the common case, and
  // editing is deliberate. Edits used to vanish on navigation because
  // nothing persisted them; the autosave below closes that.
  const [viewMode, setViewMode] = useState<'report' | 'edit'>('report');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Only autosave once the user has actually changed something --
  // otherwise merely opening a meeting would rewrite its stored summary.
  const dirtyRef = useRef(false);
  const savedSnapshotRef = useRef<string>('');

  // Every edit path in this component calls onSummaryChange, so wrapping
  // the prop marks edits dirty in one place instead of at 11 call sites.
  const onSummaryChange = useCallback(
    (next: Summary) => {
      dirtyRef.current = true;
      onSummaryChangeProp(next);
    },
    [onSummaryChangeProp],
  );

  const generateUniqueId = (sectionKey: string) => {
    return `${sectionKey}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  };

  // Normalize whatever summary shape we're handed into strictly-renderable
  // sections. Older/cloud summaries can carry a `MeetingName` that is a string
  // OR a { title, blocks } object, and blocks whose content isn't a string —
  // rendering any of those directly throws React error #31 ("object with keys
  // {title, blocks}") and white-screens the page. This guards every render
  // path (initial load, poll, regenerate) in one place.
  const currentSummary = useMemo<Summary>(() => {
    const empty: Summary = {
      Agenda: { title: "Agenda", blocks: [] },
      Decisions: { title: "Decisions", blocks: [] },
      ActionItems: { title: "Action Items", blocks: [] },
      ClosingRemarks: { title: "Closing Remarks", blocks: [] },
    };
    if (!summary || typeof summary !== 'object') return empty;

    const clean: Summary = {} as Summary;
    for (const [sectionKey, raw] of Object.entries(summary as Record<string, any>)) {
      // MeetingName is a title, not a section — never render it as one.
      if (sectionKey === 'MeetingName') continue;
      // Only real sections (an object with a blocks array) can render.
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.blocks)) continue;
      clean[sectionKey] = {
        title: typeof raw.title === 'string' ? raw.title : String(sectionKey),
        blocks: raw.blocks
          .filter((b: any) => b && typeof b === 'object')
          .map((b: any) => ({
            id:
              typeof b.id === 'string' && b.id.includes(sectionKey)
                ? b.id
                : generateUniqueId(sectionKey),
            type: 'bullet' as const,
            color: 'default' as const,
            content: typeof b.content === 'string' ? b.content : String(b?.content ?? ''),
          })),
      };
    }
    return Object.keys(clean).length > 0 ? clean : empty;
  }, [summary]);

  // Autosave edits, debounced so typing doesn't hammer the backend.
  useEffect(() => {
    if (!dirtyRef.current || !meeting?.id) return;
    const payload = JSON.stringify(currentSummary);
    if (payload === savedSnapshotRef.current) return;

    setSaveState('saving');
    const t = setTimeout(async () => {
      try {
        const resp = await fetch('http://localhost:5167/save-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ meeting_id: meeting.id, summary: currentSummary }),
        });
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        savedSnapshotRef.current = payload;
        setSaveState('saved');
        // Clear the indicator after a beat so it doesn't linger.
        setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2000);
      } catch {
        setSaveState('error');
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [currentSummary, meeting?.id]);

  const [selectedBlocks, setSelectedBlocks] = useState<string[]>([]);
  const [lastSelectedBlock, setLastSelectedBlock] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartBlock, setDragStartBlock] = useState<string | null>(null);
  const hiddenInputRef = useRef<HTMLTextAreaElement>(null);

  // History management
  const [history, setHistory] = useState<Summary[]>([currentSummary]);
  const [currentHistoryIndex, setCurrentHistoryIndex] = useState(0);
  const [isUndoRedoing, setIsUndoRedoing] = useState(false);

  // Add to history when summary changes
  useEffect(() => {
    if (!isUndoRedoing && summary) {  // Only update history if summary is not null
      const newHistory = history.slice(0, currentHistoryIndex + 1);
      newHistory.push(summary);
      setHistory(newHistory);
      setCurrentHistoryIndex(newHistory.length - 1);
    }
    setIsUndoRedoing(false);
  }, [summary]);

  const handleUndo = useCallback(() => {
    if (currentHistoryIndex > 0) {
      setIsUndoRedoing(true);
      const newIndex = currentHistoryIndex - 1;
      setCurrentHistoryIndex(newIndex);
      onSummaryChange(history[newIndex]);
    }
  }, [currentHistoryIndex, history, onSummaryChange]);

  const handleRedo = useCallback(() => {
    if (currentHistoryIndex < history.length - 1) {
      setIsUndoRedoing(true);
      const newIndex = currentHistoryIndex + 1;
      setCurrentHistoryIndex(newIndex);
      onSummaryChange(history[newIndex]);
    }
  }, [currentHistoryIndex, history, onSummaryChange]);

  // ── Share: build markdown, copy to clipboard, save to file ──
  // The markdown follows a deliberately plain shape so it pastes
  // cleanly into Slack / email / Notion: H1 title + date, then one H2
  // per non-empty section with bullets. Empty sections are skipped
  // (matches Phase 3 Task 7.5 hide-empty-sections behavior in the UI).
  const [shareFlash, setShareFlash] = useState<string | null>(null);

  const buildMarkdown = useCallback((): string => {
    const lines: string[] = [];
    const title = meeting?.title?.trim() || 'Meeting summary';
    lines.push(`# ${title}`);
    if (meeting?.created_at) {
      try {
        const dt = new Date(meeting.created_at);
        if (!isNaN(dt.getTime())) {
          lines.push('');
          lines.push(`_Recorded ${dt.toLocaleString()}_`);
        }
      } catch {
        /* ignore parse failures */
      }
    }
    for (const [, section] of Object.entries(currentSummary)) {
      if (!section?.blocks?.length) continue;
      lines.push('');
      lines.push(`## ${section.title}`);
      for (const block of section.blocks) {
        const text = (block.content ?? '').trim();
        if (!text) continue;
        lines.push(`- ${text}`);
      }
    }
    return lines.join('\n') + '\n';
  }, [currentSummary, meeting?.title, meeting?.created_at]);

  const slugifyTitle = useCallback((raw: string): string => {
    const slug = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return slug || 'summary';
  }, []);

  const handleCopyMarkdown = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildMarkdown());
      setShareFlash('Copied');
      setTimeout(() => setShareFlash(null), 1500);
    } catch (err) {
      console.error('Copy summary failed', err);
      setShareFlash('Copy failed');
      setTimeout(() => setShareFlash(null), 2000);
    }
  }, [buildMarkdown]);

  const handleSaveMarkdown = useCallback(async () => {
    try {
      const dir = await downloadDir();
      const stamp = new Date().toISOString().slice(0, 10);
      const slug = slugifyTitle(meeting?.title ?? 'summary');
      // Path join with a forward slash works on Windows under Tauri's
      // fs plugin; the OS normalises it. Avoids an extra path-join
      // import for one segment.
      const path = `${dir.replace(/\\$|\/$/, '')}/${slug}-${stamp}.md`;
      await writeTextFile(path, buildMarkdown());
      setShareFlash(`Saved to ${path}`);
      setTimeout(() => setShareFlash(null), 4000);
    } catch (err) {
      console.error('Save summary failed', err);
      setShareFlash('Save failed');
      setTimeout(() => setShareFlash(null), 2000);
    }
  }, [buildMarkdown, slugifyTitle, meeting?.title]);

  const htmlOptions = useCallback(
    () => ({
      title: meeting?.title,
      date: meeting?.created_at
        ? new Date(meeting.created_at).toLocaleDateString(undefined, {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          })
        : undefined,
    }),
    [meeting?.title, meeting?.created_at],
  );

  /** Save a standalone .html file to Downloads, for attaching or opening. */
  const handleSaveHtml = useCallback(async () => {
    try {
      const dir = await downloadDir();
      const stamp = new Date().toISOString().slice(0, 10);
      const slug = slugifyTitle(meeting?.title ?? 'summary');
      const path = `${dir.replace(/\\$|\/$/, '')}/${slug}-${stamp}.html`;
      await writeTextFile(path, summaryHtmlDocument(currentSummary, htmlOptions()));
      setShareFlash(`Saved to ${path}`);
      setTimeout(() => setShareFlash(null), 4000);
    } catch (err) {
      console.error('Save summary as HTML failed', err);
      setShareFlash('Save failed');
      setTimeout(() => setShareFlash(null), 2000);
    }
  }, [currentSummary, htmlOptions, slugifyTitle, meeting?.title]);

  /** Put rich HTML on the clipboard so a paste keeps its formatting. */
  const handleCopyHtml = useCallback(async () => {
    const html = summaryHtmlFragment(currentSummary, htmlOptions());
    try {
      // text/html is what makes Gmail, Notion and Docs paste formatted
      // rather than as a wall of plain text; the text/plain alternative
      // is the fallback for editors that take only plain text.
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([buildMarkdown()], { type: 'text/plain' }),
        }),
      ]);
      setShareFlash('Copied - paste into email or a doc');
    } catch {
      // Older webviews have no ClipboardItem. Markdown still beats nothing.
      try {
        await navigator.clipboard.writeText(buildMarkdown());
        setShareFlash('Copied as text');
      } catch {
        setShareFlash('Copy failed');
      }
    }
    setTimeout(() => setShareFlash(null), 3000);
  }, [currentSummary, htmlOptions, buildMarkdown]);

  const getAllBlocks = () => {
    const allBlocks: { id: string; sectionKey: string }[] = [];
    Object.entries(currentSummary).forEach(([sectionKey, section]) => {
      section.blocks.forEach(block => {
        allBlocks.push({ id: block.id, sectionKey });
      });
    });
    return allBlocks;
  };

  const findBlockAndSection = (blockId: string) => {
    for (const [sectionKey, section] of Object.entries(currentSummary)) {
      const block = section.blocks.find(b => b.id === blockId);
      if (block) {
        return { block, sectionKey };
      }
    }
    return null;
  };

  const handleBlockNavigate = (blockId: string, direction: 'up' | 'down') => {
    const allBlocks = getAllBlocks();
    const currentIndex = allBlocks.findIndex(b => b.id === blockId);
    
    if (currentIndex === -1) return;
    
    let targetIndex: number;
    if (direction === 'up') {
      targetIndex = currentIndex > 0 ? currentIndex - 1 : currentIndex;
    } else {
      targetIndex = currentIndex < allBlocks.length - 1 ? currentIndex + 1 : currentIndex;
    }
    
    if (targetIndex !== currentIndex) {
      const targetBlock = allBlocks[targetIndex];
      setSelectedBlocks([targetBlock.id]);
      setLastSelectedBlock(targetBlock.id);
    }
  };

  const getBlockRange = (startId: string, endId: string) => {
    const allBlocks = getAllBlocks();
    const startIndex = allBlocks.findIndex(b => b.id === startId);
    const endIndex = allBlocks.findIndex(b => b.id === endId);
    
    if (startIndex === -1 || endIndex === -1) return [];
    
    const start = Math.min(startIndex, endIndex);
    const end = Math.max(startIndex, endIndex);
    
    return allBlocks.slice(start, end + 1).map(b => b.id);
  };

  const handleBlockMouseDown = (blockId: string, sectionKey: keyof Summary, e: React.MouseEvent<HTMLDivElement>) => {
    if (!e.shiftKey) {
      setDragStartBlock(blockId);
      setLastSelectedBlock(blockId);
      setSelectedBlocks([blockId]);
    }
    setIsDragging(true);
  };

  const handleBlockMouseEnter = (blockId: string, sectionKey: keyof Summary) => {
    if (isDragging && dragStartBlock) {
      const range = getBlockRange(dragStartBlock, blockId);
      setSelectedBlocks(range);
    }
  };

  const handleBlockMouseUp = (blockId: string, sectionKey: keyof Summary, e: React.MouseEvent<HTMLDivElement>) => {
    if (e.shiftKey && lastSelectedBlock) {
      const range = getBlockRange(lastSelectedBlock, blockId);
      setSelectedBlocks(range);
    }
    setIsDragging(false);
  };

  const handleBlockChange = (sectionKey: keyof Summary, blockId: string, newContent: string) => {
    onSummaryChange({
      ...currentSummary,
      [sectionKey]: {
        ...currentSummary[sectionKey],
        blocks: currentSummary[sectionKey].blocks.map(block => 
          block.id === blockId ? { ...block, content: newContent } : block
        )
      }
    });
  };

  const handleBlockTypeChange = (blockId: string, newType: Block['type']) => {
    // Find the section key for this block
    let blockSectionKey: string | null = null;
    for (const [sectionKey, section] of Object.entries(currentSummary)) {
      if (section.blocks.some(b => b.id === blockId)) {
        blockSectionKey = sectionKey;
        break;
      }
    }

    if (!blockSectionKey) return;

    onSummaryChange({
      ...currentSummary,
      [blockSectionKey]: {
        ...currentSummary[blockSectionKey],
        blocks: currentSummary[blockSectionKey].blocks.map(block => 
          block.id === blockId ? { ...block, type: newType } : block
        )
      }
    });
  };

  const handleTitleChange = (sectionKey: keyof Summary, newTitle: string) => {
    console.log('Title change:', { sectionKey, newTitle });
    const updatedSummary = {
      ...currentSummary,
      [sectionKey]: {
        ...currentSummary[sectionKey],
        title: newTitle
      }
    };
    console.log('Updated summary:', updatedSummary);
    onSummaryChange(updatedSummary);
  };

  const handleKeyDown = (e: React.KeyboardEvent, blockId: string) => {
    // Find the section key for this block
    let blockSectionKey: string | null = null;
    let currentBlockIndex = -1;
    
    for (const [sectionKey, section] of Object.entries(currentSummary)) {
      currentBlockIndex = section.blocks.findIndex(b => b.id === blockId);
      if (currentBlockIndex !== -1) {
        blockSectionKey = sectionKey;
        break;
      }
    }

    if (!blockSectionKey) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const currentBlock = currentSummary[blockSectionKey].blocks[currentBlockIndex];
      
      if (!currentBlock) return;
      
      const newId = generateUniqueId(blockSectionKey);
      const textarea = e.target as HTMLTextAreaElement;
      const newBlockContent = textarea.dataset.newBlockContent || '';
      
      // Update the blocks array for the specific section
      const updatedBlocks = [...currentSummary[blockSectionKey].blocks];
      
      // Get the type of the current block for the new block
      const newBlockType = currentBlock.type === 'bullet' ? 'bullet' : 'text';
      
      // Insert new block after current block
      updatedBlocks.splice(currentBlockIndex + 1, 0, {
        id: newId,
        type: newBlockType,
        content: newBlockContent,
        color: currentBlock.color || 'default'
      });
      
      onSummaryChange({
        ...currentSummary,
        [blockSectionKey]: {
          ...currentSummary[blockSectionKey],
          blocks: updatedBlocks
        }
      });
      
      // Focus and select the new block
      setSelectedBlocks([newId]);
      setLastSelectedBlock(newId);
      
      // Use setTimeout to ensure the textarea is mounted
      setTimeout(() => {
        const newTextarea = document.querySelector(`[data-block-id="${newId}"]`) as HTMLTextAreaElement;
        if (newTextarea) {
          newTextarea.focus();
          newTextarea.setSelectionRange(0, 0);
        }
      }, 0);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedBlocks.length > 1) {
      e.preventDefault();
      handleDeleteSelectedBlocks();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const cursorPosition = (e.target as HTMLTextAreaElement).selectionStart;
      const isAtStart = cursorPosition === 0;
      const isAtEnd = cursorPosition === (e.target as HTMLTextAreaElement).value.length;

      if ((e.key === 'ArrowUp' && isAtStart) || (e.key === 'ArrowDown' && isAtEnd)) {
        e.preventDefault();
        handleBlockNavigate(blockId, e.key === 'ArrowUp' ? 'up' : 'down');
      }
    }
  };

  const handleBlockDelete = (blockId: string, mergeContent?: string) => {
    // Find the section key for this block
    let blockSectionKey: string | null = null;
    let currentBlockIndex = -1;

    for (const [sectionKey, section] of Object.entries(currentSummary)) {
      currentBlockIndex = section.blocks.findIndex(b => b.id === blockId);
      if (currentBlockIndex !== -1) {
        blockSectionKey = sectionKey;
        break;
      }
    }

    if (!blockSectionKey) return;

    const updatedBlocks = [...currentSummary[blockSectionKey].blocks];
    
    // If there's content to merge and a previous block exists
    if (mergeContent && currentBlockIndex > 0) {
      const previousBlock = updatedBlocks[currentBlockIndex - 1];
      const previousContent = previousBlock.content;
      const cursorPosition = previousContent.length;
      
      // Update previous block with merged content
      updatedBlocks[currentBlockIndex - 1] = {
        ...previousBlock,
        content: previousContent + mergeContent
      };
      
      // Remove current block
      updatedBlocks.splice(currentBlockIndex, 1);
      
      onSummaryChange({
        ...currentSummary,
        [blockSectionKey]: {
          ...currentSummary[blockSectionKey],
          blocks: updatedBlocks
        }
      });

      // Select the previous block and set cursor at merge point
      setSelectedBlocks([previousBlock.id]);
      setLastSelectedBlock(previousBlock.id);
      
      // Use setTimeout to ensure the textarea is mounted
      setTimeout(() => {
        const textarea = document.querySelector(`[data-block-id="${previousBlock.id}"]`) as HTMLTextAreaElement;
        if (textarea) {
          textarea.focus();
          textarea.setSelectionRange(cursorPosition, cursorPosition);
        }
      }, 0);
    } else {
      // Just remove the block if no content to merge
      updatedBlocks.splice(currentBlockIndex, 1);
      
      onSummaryChange({
        ...currentSummary,
        [blockSectionKey]: {
          ...currentSummary[blockSectionKey],
          blocks: updatedBlocks
        }
      });

      // Select the previous block if it exists, otherwise the next block
      if (updatedBlocks.length > 0) {
        const newSelectedBlock = updatedBlocks[Math.max(0, currentBlockIndex - 1)];
        setSelectedBlocks([newSelectedBlock.id]);
        setLastSelectedBlock(newSelectedBlock.id);
      } else {
        setSelectedBlocks([]);
        setLastSelectedBlock(null);
      }
    }
  };

  const getSelectedBlocksContent = useCallback(() => {
    return selectedBlocks
      .map(blockId => {
        for (const [sectionKey, section] of Object.entries(currentSummary)) {
          const block = section.blocks.find(b => b.id === blockId);
          if (block) {
            return block.content;
          }
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }, [selectedBlocks, currentSummary]);

  useEffect(() => {
    if (hiddenInputRef.current && selectedBlocks.length > 1) {
      const content = getSelectedBlocksContent();
      hiddenInputRef.current.value = content;
      hiddenInputRef.current.select();
    }
  }, [selectedBlocks, getSelectedBlocksContent]);

  useEffect(() => {
    const handleMouseUp = () => {
      setIsDragging(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey)) {
        if (e.key === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            handleRedo();
          } else {
            handleUndo();
          }
        } else if (e.key === 'c') {
          const blockContents = selectedBlocks.map(blockId => {
            for (const [sectionKey, section] of Object.entries(currentSummary)) {
              const block = section.blocks.find(b => b.id === blockId);
              if (block) {
                return block.content;
              }
            }
            return '';
          }).filter(Boolean);

          navigator.clipboard.writeText(blockContents.join('\n'));
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedBlocks.length > 1) {
        e.preventDefault();
        handleDeleteSelectedBlocks();
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedBlocks, currentSummary, handleUndo, handleRedo]);

  const handleDeleteSelectedBlocks = () => {
    // Group selected blocks by section
    const blocksBySection = new Map<string, string[]>();
    selectedBlocks.forEach(blockId => {
      Object.entries(currentSummary).forEach(([sectionKey, section]) => {
        if (section.blocks.some(b => b.id === blockId)) {
          const blocks = blocksBySection.get(sectionKey) || [];
          blocks.push(blockId);
          blocksBySection.set(sectionKey, blocks);
        }
      });
    });

    // Create new summary with blocks removed
    const newSummary = { ...currentSummary };
    blocksBySection.forEach((blockIds, sectionKey) => {
      newSummary[sectionKey] = {
        ...newSummary[sectionKey],
        blocks: newSummary[sectionKey].blocks.filter(b => !blockIds.includes(b.id))
      };
    });

    onSummaryChange(newSummary);
    setSelectedBlocks([]);
    setLastSelectedBlock(null);
  };

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    visible: boolean;
  }>({ x: 0, y: 0, visible: false });

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = () => {
      setContextMenu(prev => ({ ...prev, visible: false }));
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      visible: true
    });
  };

  const handleCopyBlocks = useCallback(() => {
    const content = getSelectedBlocksContent();
    navigator.clipboard.writeText(content);
    setContextMenu(prev => ({ ...prev, visible: false }));
  }, [getSelectedBlocksContent]);

  const handleDeleteBlocks = () => {
    handleDeleteSelectedBlocks();
    setContextMenu(prev => ({ ...prev, visible: false }));
  };

  const handleSectionDelete = (sectionKey: keyof Summary) => {
    const newSummary = { ...currentSummary };
    delete newSummary[sectionKey];
    onSummaryChange(newSummary);
  };

  const handleAddSection = () => {
    const newSectionKey = `section${Object.keys(currentSummary).length + 1}`;
    const newBlockId = Date.now().toString();
    const newSummary: Summary = {
      ...currentSummary,
      [newSectionKey]: {
        title: 'New Section',
        blocks: [{
          id: newBlockId,
          type: 'text' as const,
          content: '',
          color: 'default' as const
        }]
      }
    };
    onSummaryChange(newSummary);
    
    // Select the new block
    setSelectedBlocks([newBlockId]);
    setLastSelectedBlock(newBlockId);
  };

  const convertToMarkdown = () => {
    let markdown = `# AI Generated Summary of Meeting: ${meeting?.id || 'Unknown'} - ${meeting?.title || 'Untitled Meeting'}\n\n`;
    markdown += `## Date: ${meeting?.created_at ? new Date(meeting.created_at).toLocaleDateString() : new Date().toLocaleDateString()}\n\n`;
    
    Object.entries(currentSummary).forEach(([key, section]) => {
      if (key === 'title') {
        markdown = `# ${section.title || 'AI Enhanced Summary'}\n\n`;
      } else {
        markdown += `## ${section.title || key}\n\n`;
        section.blocks.forEach(block => {
          switch (block.type) {
            case 'heading1':
              markdown += `### ${block.content}\n\n`;
              break;
            case 'heading2':
              markdown += `#### ${block.content}\n\n`;
              break;
            case 'bullet':
              markdown += `- ${block.content}\n`;
              break;
            case 'text':
            default:
              markdown += `${block.content}\n\n`;
          }
        });
        // Add an extra newline after bullet lists
        if (section.blocks.some(block => block.type === 'bullet')) {
          markdown += '\n';
        }
      }
    });
    
    return markdown;
  };

  const handleExport = () => {
    const markdown = convertToMarkdown();
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentSummary.title || 'ai-summary'}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const renderErrorState = () => (
    <div className="w-full p-4 bg-rw-danger-bg border border-rw-danger-bg rounded-rw-md">
      <div className="flex items-center mb-1.5 gap-2">
        <ExclamationTriangleIcon className="h-4 w-4 text-rw-danger-text" />
        <h3 className="text-rw-danger-text text-[14px] font-medium">Error Generating Summary</h3>
      </div>
      <p className="text-rw-danger-text/90 text-[13px]">{error}</p>
      <p className="text-rw-danger-text/70 text-[11px] mt-1.5">Please try again or contact support if the issue persists.</p>
    </div>
  );

  const renderLoadingState = () => (
    <div className="w-full p-4 bg-rw-info-bg border border-rw-info-bg rounded-rw-md">
      <div className="flex items-center gap-3">
        <div className="animate-spin rounded-full h-4 w-4 border-2 border-rw-info-text border-t-transparent"></div>
        <div>
          <h3 className="text-rw-info-text text-[14px] font-medium">
            {status === 'processing' ? 'Processing Transcript' : 'Generating Summary'}
          </h3>
          <p className="text-rw-info-text/80 text-[13px]">
            {status === 'processing'
              ? 'Analyzing your transcript…'
              : 'Creating a detailed summary of your meeting…'}
          </p>
        </div>
      </div>
    </div>
  );

  if (error) {
    return renderErrorState();
  }

  if (status === 'processing' || status === 'summarizing' || status === 'regenerating') {
    return renderLoadingState();
  }

  const hasContent = Object.values(currentSummary).some(section => section?.blocks?.length > 0);

  if (!hasContent && status === 'completed') {
    return (
      <div className="w-full p-5 bg-rw-subtle border border-rw-border rounded-rw-md text-center">
        <p className="text-rw-text-primary text-[14px]">No summary content available.</p>
        <p className="text-rw-text-tertiary text-[12px] mt-1">Try generating a new summary.</p>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="flex justify-end items-center mb-4 space-x-2">
        {shareFlash && (
          <span
            className="text-[11px] text-rw-text-tertiary mr-1 truncate max-w-[260px]"
            title={shareFlash}
          >
            {shareFlash}
          </span>
        )}
        <button
          onClick={handleCopyMarkdown}
          className="p-2 hover:bg-gray-100 rounded inline-flex items-center gap-1.5 text-[12px] text-rw-text-secondary hover:text-rw-text-primary"
          title="Copy summary as Markdown"
          aria-label="Copy summary as Markdown"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          <span>Copy</span>
        </button>
        <button
          onClick={handleSaveMarkdown}
          className="p-2 hover:bg-gray-100 rounded inline-flex items-center gap-1.5 text-[12px] text-rw-text-secondary hover:text-rw-text-primary"
          title="Save summary as .md to Downloads"
          aria-label="Save summary as Markdown file"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span>Save</span>
        </button>
        <span className="w-px h-5 bg-rw-border mx-1" aria-hidden />
        <button
          onClick={handleUndo}
          disabled={currentHistoryIndex === 0}
          className="p-2 hover:bg-gray-100 rounded disabled:opacity-50"
          title="Undo"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 7v6h6" />
            <path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13" />
          </svg>
        </button>
        <button
          onClick={handleRedo}
          disabled={currentHistoryIndex === history.length - 1}
          className="p-2 hover:bg-gray-100 rounded disabled:opacity-50"
          title="Redo"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 7v6h-6" />
            <path d="M3 17a9 9 0 019-9 9 9 0 016 2.3l3 2.7" />
          </svg>
        </button>
        <button
          onClick={handleAddSection}
          className="p-2 hover:bg-gray-100 rounded"
          title="Add new section"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
        </button>
      </div>
      
      {selectedBlocks.length > 1 && (
        <textarea
          ref={hiddenInputRef}
          className="sr-only"
          readOnly
          value={getSelectedBlocksContent()}
          tabIndex={-1}
        />
      )}
      
      {/* Context Menu */}
      {contextMenu.visible && selectedBlocks.length > 0 && (
        <div
          className="fixed z-50 bg-white shadow-lg rounded-lg py-1 min-w-[160px] border border-gray-200"
          style={{ 
            left: contextMenu.x, 
            top: contextMenu.y,
            transform: 'translate(-50%, -50%)'
          }}
          onClick={e => e.stopPropagation()}
        >
          <button
            className="w-full px-4 py-2 text-left hover:bg-gray-100 flex items-center space-x-2"
            onClick={handleCopyBlocks}
          >
            <span className="text-gray-600">📋</span>
            <span>Copy {selectedBlocks.length > 1 ? `${selectedBlocks.length} blocks` : 'block'}</span>
          </button>
          <button
            className="w-full px-4 py-2 text-left hover:bg-gray-100 text-red-600 flex items-center space-x-2"
            onClick={handleDeleteBlocks}
          >
            <span>🗑️</span>
            <span>Delete {selectedBlocks.length > 1 ? `${selectedBlocks.length} blocks` : 'block'}</span>
          </button>
        </div>
      )}

      {/* Phase 4 Task 2.5: header tile in Neato teal. Heading bumps to
          17px to match the new heading scale. */}
      <div className="flex items-center gap-2.5 mb-5">
        <span
          className="inline-flex items-center justify-center w-6 h-6 rounded-rw-sm bg-rw-primary-bg text-rw-primary text-[14px]"
          aria-hidden
        >
          ✦
        </span>
        <h2 className="text-[17px] font-medium text-rw-text-primary">
          AI Enhanced Summary
        </h2>
        <div className="ml-auto flex items-center gap-1.5">
          {/* Report is the default; Edit is a mode you enter on purpose.
              Two co-equal tabs would leave it ambiguous which copy is
              real -- a single toggle does not. */}
          <div
            className="inline-flex rounded-rw-md border border-rw-border overflow-hidden mr-1"
            role="group"
            aria-label="Summary view"
          >
            {(['report', 'edit'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setViewMode(m)}
                aria-pressed={viewMode === m}
                className={`px-2.5 py-1 text-[12px] transition-colors ${
                  viewMode === m
                    ? 'bg-rw-primary-bg text-rw-success-text font-medium'
                    : 'text-rw-text-secondary hover:bg-rw-hover'
                }`}
              >
                {m === 'report' ? 'Report' : 'Edit'}
              </button>
            ))}
          </div>
          {saveState !== 'idle' && (
            <span
              className={`font-mono text-[10px] mr-1 ${
                saveState === 'error' ? 'text-rw-danger-text' : 'text-rw-text-tertiary'
              }`}
              aria-live="polite"
            >
              {saveState === 'saving'
                ? 'Saving…'
                : saveState === 'saved'
                  ? 'Saved'
                  : 'Not saved'}
            </span>
          )}
          <button
            onClick={handleCopyHtml}
            className="px-2.5 py-1 text-[12px] text-rw-text-secondary hover:text-rw-text-primary hover:bg-rw-hover rounded-rw-md inline-flex items-center gap-1"
            title="Copy formatted - paste into email, Notion or Docs"
          >
            <span>Copy</span>
          </button>
          <button
            onClick={handleSaveHtml}
            className="px-2.5 py-1 text-[12px] text-rw-text-secondary hover:text-rw-text-primary hover:bg-rw-hover rounded-rw-md inline-flex items-center gap-1"
            title="Save as a shareable HTML file in Downloads"
          >
            <span>Save HTML</span>
          </button>
          <button
            onClick={() => {
              const markdown = convertToMarkdown();
              navigator.clipboard.writeText(markdown);
            }}
            className="px-2.5 py-1 text-[12px] text-rw-text-secondary hover:text-rw-text-primary hover:bg-rw-hover rounded-rw-md inline-flex items-center gap-1"
          >
            <span>📋</span>
            <span>Copy as Markdown</span>
          </button>
          {/* <button
            onClick={handleExport}
            className="px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200 rounded-md flex items-center space-x-1"
          >
            <span>📝</span>
            <span>Export as Markdown</span>
          </button> */}
          <button
            onClick={onRegenerateSummary}
            className="px-2.5 py-1 text-[12px] text-rw-text-secondary hover:text-rw-text-primary hover:bg-rw-hover rounded-rw-md inline-flex items-center gap-1.5"
            title="Regenerate Summary"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span>Regenerate</span>
            <kbd className="ml-0.5 font-mono text-[10px] text-rw-text-tertiary bg-rw-subtle border border-rw-border rounded-sm px-1 py-px">
              ⌘R
            </kbd>
          </button>
        </div>
      </div>

      {viewMode === 'report' && (
        <SummaryReport
          summary={currentSummary}
          meetingTitle={meeting?.title}
          meetingDate={
            meeting?.created_at
              ? new Date(meeting.created_at).toLocaleDateString(undefined, {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })
              : undefined
          }
        />
      )}

      {viewMode === 'edit' && Object.entries(currentSummary)
        .filter(([, section]) => (section?.blocks?.length ?? 0) > 0)
        .map(([key, section]) => (
        <Section
          key={key}
          section={section}
          sectionKey={key}
          selectedBlocks={selectedBlocks}
          onBlockTypeChange={handleBlockTypeChange}
          onBlockChange={(blockId, content) => handleBlockChange(key, blockId, content)}
          onBlockMouseDown={(blockId, e) => handleBlockMouseDown(blockId, key, e)}
          onBlockMouseEnter={(blockId) => handleBlockMouseEnter(blockId, key)}
          onBlockMouseUp={(blockId, e) => handleBlockMouseUp(blockId, key, e)}
          onKeyDown={handleKeyDown}
          onTitleChange={handleTitleChange}
          onSectionDelete={handleSectionDelete}
          onBlockDelete={(blockId, mergeContent) => handleBlockDelete(blockId, mergeContent)}
          onContextMenu={handleContextMenu}
          onBlockNavigate={(blockId, direction) => handleBlockNavigate(blockId, direction)}
        />
      ))}
    </div>
  );
};
