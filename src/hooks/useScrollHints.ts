import { useEffect, type RefObject } from "react";
import { updateScrollHint } from "../lib/dom";

export function useScrollHints(
  scrollRef: RefObject<HTMLElement>,
  frameRef: RefObject<HTMLElement>,
  enabled = true,
) {
  useEffect(() => {
    const scrollNode = scrollRef.current;
    const frameNode = frameRef.current;
    if (!enabled || !scrollNode || !frameNode) return;
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateScrollHint(scrollNode, frameNode);
      });
    };
    update();
    scrollNode.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scrollNode);
    return () => {
      scrollNode.removeEventListener("scroll", update);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [enabled, scrollRef, frameRef]);
}
