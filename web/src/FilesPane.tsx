/**
 * Files pane: the open-tabs strip atop the scrollable folder tree. Both belong
 * here — navigating documents (open tabs) and finding them (the tree) are one
 * concern, scoped to this pane so the switcher can sit above as top-level chrome
 * and the Outline pane gets the full panel height. The tree starts fully
 * collapsed (it's a navigator, not a triage surface); the active file's row is
 * highlighted wherever it sits.
 *
 * Right-clicking a row (or empty tree space) opens a context menu — create, copy,
 * and delete actions for that row — and choosing "New" drops an inline name input
 * at the target.
 */

import { useMemo, useState } from "react";
import type { FileCreateKind } from "./createName.js";
import { buildTree, type TreeNode, workspaceRootName } from "./fileTree.js";
import { FileTypeIcon, type FileTypeSets, FolderIcon } from "./icons.js";
import { InlineCreate } from "./InlineCreate.js";
import { Tabs } from "./Tabs.js";
import type { Tabs as TabsState } from "./useTabs.js";

/** Where an inline create input is currently shown (parent "" = root). */
export interface CreateTarget {
  kind: FileCreateKind | "folder";
  parent: string;
}

interface RowActions {
  /** Open the context menu for a folder/file row (or root) at a screen point. */
  onContextMenu: (e: React.MouseEvent, target: { kind: "folder" | "file" | "root"; path: string }) => void;
  createTarget: CreateTarget | null;
  onCommitCreate: (name: string) => void;
  onCancelCreate: () => void;
  /** Request moving a doc/folder INTO a destination folder ("" = root). */
  onMove: (from: string, destFolder: string) => void;
}

/** The directory holding `path` (root = ""). The no-op drop target for a move. */
function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function FilesPane({
  root,
  paths,
  images,
  htmls,
  pdfs,
  drawings,
  dirs,
  activeFile,
  tabs,
  expanded,
  onToggleDir,
  onOpenFile,
  onOpenInNewTab,
  actions,
}: {
  /** Absolute path returned by the index; only its folder name labels the tree. */
  root: string;
  paths: string[];
  /** Which of `paths` are image files — rendered with the image icon. */
  images: string[];
  /** Which of `paths` are HTML files — rendered with the html icon. */
  htmls: string[];
  /** Which of `paths` are PDF files — rendered with the PDF icon. */
  pdfs: string[];
  /** Which of `paths` are Excalidraw scenes — rendered with the drawing icon. */
  drawings: string[];
  dirs: string[];
  activeFile: string | null;
  tabs: TabsState;
  /** Expanded-folder set, owned by Nav so it survives pane switches (this
   *  pane unmounts when the user views the Outline). */
  expanded: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (file: string) => void;
  onOpenInNewTab: (file: string) => void;
  actions: RowActions;
}) {
  const { root: tree } = useMemo(() => buildTree(paths, dirs), [paths, dirs]);
  // One grouped set feeds both the tree rows and the tab strip, so the two
  // can't classify the same file differently.
  const fileTypes: FileTypeSets = useMemo(
    () => ({
      images: new Set(images),
      htmls: new Set(htmls),
      pdfs: new Set(pdfs),
      drawings: new Set(drawings),
    }),
    [images, htmls, pdfs, drawings],
  );

  // Drag-to-move state: the path being dragged, and the folder currently hovered
  // as a drop target (for the `.drop-into` highlight). "" = root; null = none.
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);

  // A drop INTO `destFolder` is valid unless it's a no-op (already there) or a
  // folder being dropped into itself or a descendant. Mirrors the backend guard.
  function canDrop(from: string, destFolder: string): boolean {
    if (from === "") return false;
    if (parentDir(from) === destFolder) return false; // already there
    if (destFolder === from || destFolder.startsWith(from + "/")) return false; // into self
    return true;
  }

  const drag = {
    dragPath,
    dropDir,
    onDragStart(path: string) {
      setDragPath(path);
    },
    onDragEnd() {
      setDragPath(null);
      setDropDir(null);
    },
    onDragOverDir(e: React.DragEvent, destFolder: string) {
      if (dragPath === null || !canDrop(dragPath, destFolder)) return;
      e.preventDefault(); // allow the drop
      if (dropDir !== destFolder) setDropDir(destFolder);
    },
    onDropDir(e: React.DragEvent, destFolder: string) {
      e.preventDefault();
      const from = dragPath;
      setDragPath(null);
      setDropDir(null);
      if (from !== null && canDrop(from, destFolder)) actions.onMove(from, destFolder);
    },
  };

  return (
    <div className="files-pane">
      <Tabs tabs={tabs} fileTypes={fileTypes} />
      <div
        className={`nav-tree${dropDir === "" ? " drop-into-root" : ""}`}
        // Right-click in the empty area below the tree → create at root.
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) actions.onContextMenu(e, { kind: "root", path: "" });
        }}
        // Dropping onto empty tree space moves to the root.
        onDragOver={(e) => drag.onDragOverDir(e, "")}
        onDrop={(e) => drag.onDropDir(e, "")}
      >
        <div className="files-section-label">{workspaceRootName(root)}</div>
        <TreeLevel
          node={tree}
          depth={0}
          expanded={expanded}
          activeFile={activeFile}
          fileTypes={fileTypes}
          onToggleDir={onToggleDir}
          onOpenFile={onOpenFile}
          onOpenInNewTab={onOpenInNewTab}
          actions={actions}
          drag={drag}
        />
      </div>
    </div>
  );
}

interface DragState {
  dragPath: string | null;
  dropDir: string | null;
  onDragStart: (path: string) => void;
  onDragEnd: () => void;
  onDragOverDir: (e: React.DragEvent, destFolder: string) => void;
  onDropDir: (e: React.DragEvent, destFolder: string) => void;
}

function TreeLevel({
  node,
  depth,
  expanded,
  activeFile,
  fileTypes,
  onToggleDir,
  onOpenFile,
  onOpenInNewTab,
  actions,
  drag,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  activeFile: string | null;
  fileTypes: FileTypeSets;
  onToggleDir: (path: string) => void;
  onOpenFile: (file: string) => void;
  onOpenInNewTab: (file: string) => void;
  actions: RowActions;
  drag: DragState;
}) {
  const files = [...node.files].sort((a, b) => a.localeCompare(b));
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));

  // A create input targeting THIS node renders with its kind's group — a new
  // file lands among the files, a new folder among the folders — at any depth.
  const create = actions.createTarget?.parent === node.path ? actions.createTarget : null;
  const inlineInput = create && (
    <InlineCreate
      kind={create.kind}
      depth={depth}
      onCommit={actions.onCommitCreate}
      onCancel={actions.onCancelCreate}
    />
  );

  return (
    <>
      {files.map((file) => {
        const name = file.split("/").pop() ?? file;
        const active = file === activeFile;
        return (
          <a
            key={file}
            className={`nav-row${active ? " active" : ""}${
              drag.dragPath === file ? " dragging" : ""
            }`}
            href={`/?file=${encodeURIComponent(file)}`}
            data-file={file}
            title={file}
            // Depth indent only; the base left inset comes from the row's CSS
            // padding so top-level files/folders/tabs share one left edge.
            style={depth ? { paddingLeft: 8 + depth * 16 } : undefined}
            draggable
            onDragStart={() => drag.onDragStart(file)}
            onDragEnd={drag.onDragEnd}
            onClick={(e) => {
              if (e.shiftKey || e.button === 1) return;
              e.preventDefault();
              if (e.metaKey || e.ctrlKey) onOpenInNewTab(file);
              else onOpenFile(file);
            }}
            onContextMenu={(e) => actions.onContextMenu(e, { kind: "file", path: file })}
          >
            <span className="nav-file-icon">
              <FileTypeIcon path={file} types={fileTypes} />
            </span>
            <span className="nav-path">{name}</span>
          </a>
        );
      })}
      {create && create.kind !== "folder" && inlineInput}
      {dirs.map((dir) => {
        const isOpen = expanded.has(dir.path);
        return (
          <div key={dir.path}>
            <div
              className={`nav-dir-hdr${drag.dragPath === dir.path ? " dragging" : ""}${
                drag.dropDir === dir.path ? " drop-into" : ""
              }`}
              data-dir={dir.path}
              style={depth ? { paddingLeft: 8 + depth * 16 } : undefined}
              draggable
              onDragStart={(e) => {
                e.stopPropagation();
                drag.onDragStart(dir.path);
              }}
              onDragEnd={drag.onDragEnd}
              onDragOver={(e) => {
                e.stopPropagation();
                drag.onDragOverDir(e, dir.path);
              }}
              onDrop={(e) => {
                e.stopPropagation();
                drag.onDropDir(e, dir.path);
              }}
              onClick={() => onToggleDir(dir.path)}
              onContextMenu={(e) => actions.onContextMenu(e, { kind: "folder", path: dir.path })}
            >
              <span className="nav-dir-icon">
                <FolderIcon open={isOpen} />
              </span>
              <span className="nav-dir-name">{dir.name}</span>
            </div>
            {isOpen && (
              <TreeLevel
                node={dir}
                depth={depth + 1}
                expanded={expanded}
                activeFile={activeFile}
                fileTypes={fileTypes}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                onOpenInNewTab={onOpenInNewTab}
                actions={actions}
                drag={drag}
              />
            )}
          </div>
        );
      })}
      {create?.kind === "folder" && inlineInput}
    </>
  );
}
