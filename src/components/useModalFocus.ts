import { useCallback, useEffect, useLayoutEffect, type RefObject } from "react";

import { useUIStore } from "../state/ui";

type FocusRef<T extends HTMLElement = HTMLElement> = RefObject<T | null>;

type ModalStackEntry = {
  id: number;
  rootRef: FocusRef;
};

let nextModalId = 1;
let modalStack: ModalStackEntry[] = [];

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "audio[controls]",
  "video[controls]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isVisible(element: HTMLElement): boolean {
  return !!(
    element.offsetWidth ||
    element.offsetHeight ||
    element.getClientRects().length
  );
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hasAttribute("disabled"))
    .filter((element) => element.getAttribute("aria-hidden") !== "true")
    .filter(isVisible);
}

function topModalRoot(): HTMLElement | null {
  return modalStack[modalStack.length - 1]?.rootRef.current ?? null;
}

function isTopModal(root: HTMLElement): boolean {
  return topModalRoot() === root;
}

export function focusTopModalSoon(): void {
  window.requestAnimationFrame(() => {
    const root = topModalRoot();
    if (root) focusElementSoon(root);
  });
}

export function focusElementSoon(element: HTMLElement | null): void {
  window.requestAnimationFrame(() => {
    if (!element?.isConnected) return;
    element.focus({ preventScroll: true });
    window.setTimeout(() => {
      if (!element.isConnected) return;
      if (
        document.activeElement !== element &&
        !element.contains(document.activeElement)
      ) {
        element.focus({ preventScroll: true });
      }
    }, 0);
  });
}

export function useModalFocus({
  open,
  rootRef,
  initialFocusRef,
}: {
  open: boolean;
  rootRef: FocusRef;
  initialFocusRef?: FocusRef;
}): () => void {
  const beginModal = useUIStore((s) => s.beginModal);
  const endModal = useUIStore((s) => s.endModal);

  const focusModal = useCallback(() => {
    const root = rootRef.current;
    if (!root?.isConnected) return;
    const target = initialFocusRef?.current ?? root;
    if (!target.isConnected || !root.contains(target)) {
      focusElementSoon(root);
      return;
    }
    focusElementSoon(target);
  }, [initialFocusRef, rootRef]);

  useLayoutEffect(() => {
    if (!open) return;
    const entry = { id: nextModalId++, rootRef };
    modalStack = [...modalStack, entry];
    beginModal();

    return () => {
      modalStack = modalStack.filter((item) => item.id !== entry.id);
      endModal();
    };
  }, [beginModal, endModal, open, rootRef]);

  useLayoutEffect(() => {
    if (open) focusModal();
  }, [focusModal, open]);

  useEffect(() => {
    if (!open) return;

    const keepFocusInModal = (event: FocusEvent) => {
      const root = rootRef.current;
      if (!root || !isTopModal(root)) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      focusModal();
    };

    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const root = rootRef.current;
      if (!root || !isTopModal(root)) return;

      const items = focusableElements(root);
      if (items.length === 0) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }

      const active = document.activeElement;
      const currentIndex =
        active instanceof HTMLElement ? items.indexOf(active) : -1;
      const next = event.shiftKey
        ? currentIndex <= 0
          ? items[items.length - 1]
          : null
        : currentIndex === -1 || currentIndex === items.length - 1
          ? items[0]
          : null;

      if (next) {
        event.preventDefault();
        next.focus({ preventScroll: true });
      }
    };

    document.addEventListener("focusin", keepFocusInModal, true);
    document.addEventListener("keydown", trapTab, true);
    return () => {
      document.removeEventListener("focusin", keepFocusInModal, true);
      document.removeEventListener("keydown", trapTab, true);
    };
  }, [focusModal, open, rootRef]);

  return focusModal;
}
