/**
 * The open-tabs strip above the file tree. One row per open document; the
 * active tab is highlighted. Hidden entirely when nothing is open. Rows are
 * drag-to-reorder: a thin insertion line marks the drop point, and dropping
 * re-positions the tab (a pure view-order change, persisted by useTabs).
 */

import { useState } from "react";
import { FileTypeIcon, type FileTypeSets } from "./icons.js";
import type { Tabs as TabsState } from "./useTabs.js";

/** The current drop target: which tab row, and whether the line sits above it. */
interface DropMark {
  id: string;
  before: boolean;
}

export function Tabs({ tabs, fileTypes }: { tabs: TabsState; fileTypes: FileTypeSets }) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropMark, setDropMark] = useState<DropMark | null>(null);

  if (tabs.tabs.length === 0) return null;

  const clearDrag = () => {
    setDraggingId(null);
    setDropMark(null);
  };

  return (
    <div className="tab-strip">
      <div className="files-section-label">Open</div>
      {tabs.tabs.map((tab) => {
        const name = tab.file.split("/").pop() ?? tab.file;
        const active = tab.id === tabs.activeId;
        const dragging = tab.id === draggingId;
        const markBefore = dropMark?.id === tab.id && dropMark.before;
        const markAfter = dropMark?.id === tab.id && !dropMark.before;
        return (
          <div
            key={tab.id}
            className={
              `tab-row${active ? " active" : ""}${dragging ? " dragging" : ""}` +
              `${markBefore ? " drop-before" : ""}${markAfter ? " drop-after" : ""}`
            }
            title={tab.file}
            draggable
            onClick={() => {
              // A drag ends with a click event on some browsers — ignore it so a
              // reorder doesn't also switch the active tab.
              if (draggingId) return;
              tabs.focus(tab.id);
            }}
            onDragStart={(e) => {
              setDraggingId(tab.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (!draggingId || draggingId === tab.id) return;
              e.preventDefault(); // allow the drop
              e.dataTransfer.dropEffect = "move";
              // Drop above or below this row by which half the cursor is over.
              const r = e.currentTarget.getBoundingClientRect();
              const before = e.clientY < r.top + r.height / 2;
              setDropMark({ id: tab.id, before });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (draggingId && dropMark) {
                tabs.reorder(draggingId, dropMark.id, dropMark.before);
              }
              clearDrag();
            }}
            onDragEnd={clearDrag}
          >
            <span className="nav-file-icon">
              <FileTypeIcon path={tab.file} types={fileTypes} />
            </span>
            <span className="tab-name">{name}</span>
            {tab.unread && <span className="tab-dot" aria-label="unread activity" />}
            <button
              className="tab-close"
              title="Close tab"
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                tabs.close(tab.id);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
