import { dateTime, timeAgo } from "./time";

/**
 * Which build is running: `0.1.102` — package.json's major.minor and the commit count,
 * `-dev` when built with uncommitted changes (`scripts/version.sh`).
 */
export const APP_VERSION: string = __APP_VERSION__;

/** When this build was made, seconds since the epoch. */
export const BUILT_AT: number = __APP_BUILT__;

/** `review-me 0.1.102 · built 2026-10-29 18:52 (4m ago)` — what `M-x version` says. */
export function versionLine(now = Date.now() / 1000): string {
  return `review-me ${APP_VERSION} · built ${dateTime(BUILT_AT)} (${timeAgo(BUILT_AT, now)})`;
}
