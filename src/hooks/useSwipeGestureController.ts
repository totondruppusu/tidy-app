import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type SwipeGestureAction = "prev" | "next" | "trash" | "undo";

type SwipeGestureBinding = {
  enabled: boolean;
  run: () => void | Promise<void>;
};

type UseSwipeGestureControllerOptions = {
  enabled: boolean;
  isBlocked: boolean;
  actions: Record<SwipeGestureAction, SwipeGestureBinding>;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  deltaX: number;
  deltaY: number;
  activeAction: SwipeGestureAction | null;
};

const PREVIEW_DISTANCE_PX = 12;
const TRIGGER_DISTANCE_PX = 56;
const MAX_OFFSET_PX = 84;

const clampOffset = (value: number) =>
  Math.max(-MAX_OFFSET_PX, Math.min(MAX_OFFSET_PX, value));

const resolveGestureAction = (
  deltaX: number,
  deltaY: number,
): SwipeGestureAction | null => {
  if (
    Math.abs(deltaX) < PREVIEW_DISTANCE_PX &&
    Math.abs(deltaY) < PREVIEW_DISTANCE_PX
  ) {
    return null;
  }
  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return deltaX < 0 ? "prev" : "next";
  }
  return deltaY < 0 ? "trash" : "undo";
};

export const useSwipeGestureController = ({
  enabled,
  isBlocked,
  actions,
}: UseSwipeGestureControllerOptions) => {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragStateRef = useRef<DragState | null>(null);

  const resetDrag = useCallback(() => {
    dragStateRef.current = null;
    setDragState(null);
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || isBlocked) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const nextDragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        deltaX: 0,
        deltaY: 0,
        activeAction: null,
      };
      dragStateRef.current = nextDragState;
      setDragState(nextDragState);
    },
    [enabled, isBlocked],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const previous = dragStateRef.current;
      if (!previous || previous.pointerId !== event.pointerId) {
        return;
      }
      const nextDeltaX = event.clientX - previous.startX;
      const nextDeltaY = event.clientY - previous.startY;
      const nextDragState = {
        ...previous,
        deltaX: nextDeltaX,
        deltaY: nextDeltaY,
        activeAction: resolveGestureAction(nextDeltaX, nextDeltaY),
      };
      dragStateRef.current = nextDragState;
      setDragState(nextDragState);
    },
    [],
  );

  const finishPointerGesture = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      cancelled: boolean,
    ) => {
      const current = dragStateRef.current;
      if (!current || current.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released.
      }
      resetDrag();
      if (cancelled || !enabled || isBlocked || !current.activeAction) {
        return;
      }
      const distance =
        current.activeAction === "prev" || current.activeAction === "next"
          ? Math.abs(current.deltaX)
          : Math.abs(current.deltaY);
      if (distance < TRIGGER_DISTANCE_PX) {
        return;
      }
      const action = actions[current.activeAction];
      if (!action.enabled) {
        return;
      }
      void action.run();
    },
    [actions, enabled, isBlocked, resetDrag],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      finishPointerGesture(event, false);
    },
    [finishPointerGesture],
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      finishPointerGesture(event, true);
    },
    [finishPointerGesture],
  );

  return useMemo(() => {
    const activeAction = dragState?.activeAction ?? null;
    return {
      enabled,
      isBlocked,
      isDragging: dragState !== null,
      activeAction,
      activeActionAvailable: activeAction ? actions[activeAction].enabled : false,
      offsetX: clampOffset(dragState?.deltaX ?? 0),
      offsetY: clampOffset(dragState?.deltaY ?? 0),
      canPrev: actions.prev.enabled,
      canNext: actions.next.enabled,
      canTrash: actions.trash.enabled,
      canUndo: actions.undo.enabled,
      surfaceLabel:
        "Swipe the preview: left previous, right next, up trash, down undo",
      handlePointerDown,
      handlePointerMove,
      handlePointerUp,
      handlePointerCancel,
    };
  }, [
    actions,
    dragState,
    enabled,
    handlePointerCancel,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    isBlocked,
  ]);
};

export type SwipeGestureController = ReturnType<typeof useSwipeGestureController>;
