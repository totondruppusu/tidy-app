import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type RefObject,
  type MutableRefObject,
} from "react";
import type { DensityMode, FileEntry } from "../types";
import { TREE_INDENT_PX } from "../constants/appConstants";
import { formatBytes } from "../lib/format";
import { formatRelativeFolder } from "../lib/path";
import { FILE_TYPE_ICONS } from "../lib/materialIcons";
import { visibleListRows, type buildFileListModel } from "../lib/fileListModel";
import { useVirtualScroll } from "../lib/useVirtualScroll";

type Props = {
  model: ReturnType<typeof buildFileListModel>;
  scrollRef: RefObject<HTMLDivElement>;
  positionRef: MutableRefObject<{ top: number; selectedId?: string }>;
  currentId?: string;
  currentFolder: string | null;
  collapsedFolders: Record<string, boolean>;
  collapsedGroups: Record<string, boolean>;
  density: DensityMode;
  showLocation: boolean;
  isLoading: boolean;
  isMutating: boolean;
  isAndroid: boolean;
  onSelect: (file: FileEntry) => void;
  onOpen: (file: FileEntry) => void | Promise<void>;
  onTrashFolder: (path: string) => void | Promise<void>;
  onToggleFolder: (key: string) => void;
  onToggleGroup: (key: string) => void;
};

const Caret = ({ collapsed }: { collapsed: boolean }) => (
  <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
    <path d={collapsed ? "M9 5.5 16 12 9 18.5V5.5Z" : "M6 9l6 6 6-6H6Z"} />
  </svg>
);

export const VirtualFileList = memo(function VirtualFileList(props: Props) {
  const {
    model,
    scrollRef,
    currentId,
    collapsedFolders,
    collapsedGroups,
    density,
    showLocation,
  } = props;
  const rows = useMemo(
    () => visibleListRows(model.rows, collapsedFolders, collapsedGroups),
    [model, collapsedFolders, collapsedGroups],
  );
  const layout = useMemo(() => {
    const offsets = [0];
    const fileRows = new Map<string, number>();
    rows.forEach((row, i) => {
      const height =
        row.type === "group"
          ? row.meta
            ? 64
            : 40
          : row.type === "folder"
            ? 42
            : (density === "compact" ? 28 : 34) + (showLocation ? 16 : 0);
      offsets.push(offsets[i] + height);
      if (row.type === "file") fileRows.set(row.file.id, i);
    });
    return { offsets, fileRows };
  }, [rows, density, showLocation]);
  const { startIndex, endIndex, refresh } = useVirtualScroll({
    containerRef: scrollRef,
    offsets: layout.offsets,
  });
  const selectedIdRef = useRef(currentId);
  selectedIdRef.current = currentId;
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = props.positionRef.current.top;
    refresh();
    return () => {
      props.positionRef.current = {
        top: node.scrollTop,
        selectedId: selectedIdRef.current,
      };
    };
  }, [scrollRef, props.positionRef, refresh]);
  const lastSelection = useRef<{ id?: string; visible: boolean }>({
    id: props.positionRef.current.selectedId,
    visible: props.positionRef.current.selectedId !== undefined,
  });
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const index = currentId ? layout.fileRows.get(currentId) : undefined;
    const shouldReveal =
      currentId !== lastSelection.current.id || !lastSelection.current.visible;
    lastSelection.current = { id: currentId, visible: index !== undefined };
    if (!node || index === undefined || !shouldReveal) return;
    const top = layout.offsets[index];
    const bottom = layout.offsets[index + 1];
    if (top < node.scrollTop) node.scrollTop = top;
    else if (bottom > node.scrollTop + node.clientHeight)
      node.scrollTop = Math.max(0, bottom - node.clientHeight);
    refresh();
  }, [currentId, layout, scrollRef, refresh]);
  return (
    <div
      className="virtual-file-list"
      style={{ height: layout.offsets[rows.length] }}
    >
      {rows.slice(startIndex, endIndex).map((row, relativeIndex) => {
        const index = startIndex + relativeIndex;
        const style = {
          position: "absolute",
          top: layout.offsets[index],
          height: layout.offsets[index + 1] - layout.offsets[index],
          left: 0,
          right: 0,
          "--tree-indent": `${(row.type === "group" ? 0 : Math.min(row.depth ?? 0, 8)) * TREE_INDENT_PX}px`,
        } as CSSProperties;
        if (row.type === "file")
          return (
            <button
              key={row.key}
              type="button"
              style={style}
              className={`file-item ${row.file.id === currentId ? "active " : ""}${row.depth !== undefined ? "tree-item" : ""}`}
              title={row.file.path}
              aria-current={row.file.id === currentId ? "true" : undefined}
              disabled={props.isLoading || props.isMutating}
              onClick={() => props.onSelect(row.file)}
              onDoubleClick={() => {
                if (!props.isAndroid) void props.onOpen(row.file);
              }}
            >
              <span
                className={`file-type-icon badge-${row.file.kind}`}
                aria-hidden="true"
              >
                <span className="material-icon">
                  {FILE_TYPE_ICONS[row.file.kind]}
                </span>
              </span>
              <span className="file-content">
                <span className="filename">{row.file.name}</span>
                {showLocation && (
                  <span className="file-location">
                    {formatRelativeFolder(row.file.path, props.currentFolder)}
                  </span>
                )}
              </span>
            </button>
          );
        if (row.type === "folder") {
          const collapsed = Boolean(collapsedFolders[row.key]);
          return (
            <div
              key={`folder:${row.key}`}
              className="folder-item tree-item"
              style={style}
            >
              <button
                type="button"
                className="folder-item-toggle"
                onClick={() => props.onToggleFolder(row.key)}
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${row.name}`}
                disabled={props.isLoading}
                data-prevent-open-on-enter
              >
                <span className="folder-caret">
                  <Caret collapsed={collapsed} />
                </span>
                <span className="folder-label">
                  <span className="folder-name" title={row.name}>
                    {row.name}
                  </span>
                  <span className="folder-size">
                    {formatBytes(row.totalBytes)}
                  </span>
                </span>
                <span className="folder-count">{row.fileCount}</span>
              </button>
              <button
                type="button"
                className="folder-trash-button"
                onClick={() => void props.onTrashFolder(row.path)}
                aria-label={`Trash ${row.name}`}
                title={`Trash ${row.name}`}
                disabled={props.isLoading || props.isMutating}
                data-prevent-open-on-enter
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M9 4h6l1 2h4v2H4V6h4l1-2Zm1 6h2v8h-2v-8Zm4 0h2v8h-2v-8ZM7 10h2v8H7v-8Z" />
                </svg>
              </button>
            </div>
          );
        }
        const collapsed = Boolean(collapsedGroups[row.key]);
        return (
          <button
            key={`group:${row.key}`}
            type="button"
            className={`list-section-toggle${row.meta ? " list-section-duplicates" : ""}`}
            style={style}
            onClick={() => props.onToggleGroup(row.key)}
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${row.title}`}
            disabled={props.isLoading}
            data-prevent-open-on-enter
          >
            <span className="list-section-caret">
              <Caret collapsed={collapsed} />
            </span>
            <span className="list-section-text">
              <span className="list-section-title">{row.title}</span>
              {row.meta && (
                <span className="list-section-meta">{row.meta}</span>
              )}
            </span>
            <span className="list-section-count">{row.count}</span>
          </button>
        );
      })}
    </div>
  );
});
