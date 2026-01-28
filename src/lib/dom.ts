import { SCROLL_HINT_TOLERANCE } from "../constants/appConstants";

export const updateScrollHint = (scrollNode: HTMLElement, frameNode: HTMLElement) => {
  const maxScroll = scrollNode.scrollHeight - scrollNode.clientHeight;
  const canScroll = maxScroll > SCROLL_HINT_TOLERANCE;
  const showTop = canScroll && scrollNode.scrollTop > SCROLL_HINT_TOLERANCE;
  const showBottom = canScroll && scrollNode.scrollTop < maxScroll - SCROLL_HINT_TOLERANCE;
  frameNode.classList.toggle("scroll-hint-top", showTop);
  frameNode.classList.toggle("scroll-hint-bottom", showBottom);
};

export const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
};

export const shouldOpenOnEnter = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return true;
  }
  if (target === document.body || target === document.documentElement) {
    return true;
  }
  if (target.closest("[data-prevent-open-on-enter]")) {
    return false;
  }
  return Boolean(target.closest(".file-list"));
};
