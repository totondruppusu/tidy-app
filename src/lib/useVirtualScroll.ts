import {
  useCallback,
  useLayoutEffect,
  useState,
  useRef,
  type RefObject,
} from "react";

// First row whose bottom edge is beyond the requested position.
export function rowAtOffset(offsets: number[], position: number) {
  let low = 0;
  let high = Math.max(0, offsets.length - 1);
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle + 1] <= position) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function useVirtualScroll({
  containerRef,
  offsets,
  overscan = 16,
}: {
  containerRef: RefObject<HTMLElement>;
  offsets: number[];
  overscan?: number;
}) {
  const [range, setRange] = useState({ startIndex: 0, endIndex: 40 });
  const latest = useRef({ offsets, overscan });
  const refresh = useCallback(() => {
    const { offsets, overscan } = latest.current;
    const node = containerRef.current;
    if (!node) return;
    const count = offsets.length - 1;
    const startIndex = Math.max(
      0,
      Math.min(count - 1, rowAtOffset(offsets, node.scrollTop)) - overscan,
    );
    const endIndex = Math.min(
      count,
      rowAtOffset(offsets, node.scrollTop + (node.clientHeight || 600)) +
        overscan +
        1,
    );
    setRange((previous) =>
      previous.startIndex === startIndex && previous.endIndex === endIndex
        ? previous
        : { startIndex, endIndex },
    );
  }, [containerRef]);
  useLayoutEffect(() => {
    latest.current = { offsets, overscan };
    refresh();
  }, [refresh, offsets, overscan]);
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    let frame = 0;
    const schedule = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          refresh();
        });
    };
    refresh();
    node.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [containerRef, refresh]);
  // Never render an obsolete range after filtering/collapsing a long list.
  const count = offsets.length - 1;
  return {
    startIndex: Math.min(range.startIndex, Math.max(0, count - 1)),
    endIndex: Math.min(range.endIndex, count),
    refresh,
  };
}
