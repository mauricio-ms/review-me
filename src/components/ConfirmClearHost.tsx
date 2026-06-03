import { useCallback, useRef, useState } from "react";

import { clearAllTags } from "../lib/review-actions";
import { useTagsStore } from "../state/tags";
import { useUIStore } from "../state/ui";
import { useModalFocus } from "./useModalFocus";

/**
 * Confirmation for the `:clear` command. Wiping all reviewed/flag tags is
 * destructive and irreversible, so it's gated behind this keyboard-driven modal
 * (`y` confirm · `n`/`Esc` cancel) rather than firing on the bare command.
 */
export default function ConfirmClearHost() {
  const open = useUIStore((s) => s.picker === "clearTags");
  const closePicker = useUIStore((s) => s.closePicker);
  const requestFocus = useUIStore((s) => s.requestFocus);
  const reviewed = useTagsStore((s) => s.reviewed);
  const flags = useTagsStore((s) => s.flags);

  const modalRef = useRef<HTMLDivElement | null>(null);
  useModalFocus({ open, rootRef: modalRef, initialFocusRef: modalRef });

  const [busy, setBusy] = useState(false);

  const close = useCallback(() => {
    closePicker();
    requestFocus();
  }, [closePicker, requestFocus]);

  const confirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await clearAllTags();
    } finally {
      setBusy(false);
      close();
    }
  }, [busy, close]);

  if (!open) return null;

  const total = reviewed.length + flags.length;
  const body =
    total === 0
      ? "No tags to clear."
      : `Removes ${reviewed.length} reviewed + ${flags.length} flagged ` +
        `tag${total === 1 ? "" : "s"}. This can't be undone.`;

  return (
    <div className="asset-picker-backdrop">
      <div
        ref={modalRef}
        className="asset-picker neo-picker confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="Clear all tags"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "n") {
            e.preventDefault();
            close();
          } else if (e.key === "y" || e.key === "Enter") {
            e.preventDefault();
            void confirm();
          }
        }}
      >
        <div className="neo-title">Clear all tags?</div>
        <div className="confirm-body">{body}</div>
        <div className="neo-footer">
          <span>y confirm · n / Esc cancel</span>
        </div>
      </div>
    </div>
  );
}
