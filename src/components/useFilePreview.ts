import { useCallback, useLayoutEffect, useRef } from "react";
import { startPickerPreview, type PreviewOptions, type PreviewTarget } from "../lib/picker-preview";

/** One session per picker opening; targets can change without changing its origin. */
export function useFilePreview(
  enabled: boolean,
  sessionKey: unknown,
  target: PreviewTarget | null,
  options: PreviewOptions = {},
  delay = 150,
  onInvalidate = () => {},
) {
  const session = useRef<ReturnType<typeof startPickerPreview> | null>(null);
  const latest = useRef({ options, onInvalidate });
  latest.current = { options, onInvalidate };
  useLayoutEffect(() => {
    if (!enabled) return;
    const current = startPickerPreview(latest.current.options, () => latest.current.onInvalidate());
    session.current = current;
    return () => { current.finish(); if (session.current === current) session.current = null; };
  }, [enabled, sessionKey]);
  const file = target && "path" in target ? target : null;
  const frame = target && "buffer" in target ? target.buffer : null;
  const source = file?.choice.source;
  const revision = source?.kind === "commit" ? source.oid : source?.kind;
  useLayoutEffect(() => {
    if (enabled) session.current?.move(target, delay);
  }, [enabled, sessionKey, frame, file?.path, revision, file?.choice.label, file?.line, file?.col, file?.ranges, delay]);
  return useCallback((accept = false, path?: string) => session.current?.finish(accept, path) ?? false, []);
}
