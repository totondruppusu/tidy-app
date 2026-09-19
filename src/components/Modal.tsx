import { useLayoutEffect, useRef, type ReactNode } from "react";

// Shared focus/keyboard behavior for every popup, including nested confirmations.
const openModals: HTMLElement[] = [];
export function Modal({
  children,
  labelledBy,
  describedBy,
  onClose,
  className = "",
  backdropClassName = "",
  alert = false,
}: {
  children: ReactNode;
  labelledBy: string;
  describedBy?: string;
  onClose?: () => void;
  className?: string;
  backdropClassName?: string;
  alert?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const panel = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    openModals.push(panel);
    const focusable = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      ).filter((node) => !node.closest('[hidden], [aria-hidden="true"]'));
    (
      panel.querySelector<HTMLElement>("[data-dialog-initial-focus]") ??
      focusable()[0] ??
      panel
    ).focus();
    const handleKey = (event: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== panel) return;
      // Dialog keystrokes must not reach application file-action shortcuts.
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current?.();
      } else if (event.key === "Tab") {
        const nodes = focusable();
        const index = nodes.indexOf(document.activeElement as HTMLElement);
        if (!nodes.length) {
          event.preventDefault();
          panel.focus();
        } else if (event.shiftKey && index <= 0) {
          event.preventDefault();
          nodes[nodes.length - 1].focus();
        } else if (
          !event.shiftKey &&
          (index < 0 || index === nodes.length - 1)
        ) {
          event.preventDefault();
          nodes[0].focus();
        }
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (
        openModals[openModals.length - 1] === panel &&
        !panel.contains(event.target as Node)
      )
        (focusable()[0] ?? panel).focus();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("focusin", containFocus);
    return () => {
      openModals.splice(openModals.indexOf(panel), 1);
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("focusin", containFocus);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      className={`modal-backdrop ${backdropClassName}`}
      role="presentation"
      onClick={(event) => {
        if (
          event.target === event.currentTarget &&
          openModals[openModals.length - 1] === ref.current
        )
          onClose?.();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className={`modal-panel ${className}`}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
      >
        {children}
      </div>
    </div>
  );
}
