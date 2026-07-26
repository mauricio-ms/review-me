/** Thresholds in seconds, largest unit first. */
const UNITS: [limit: number, secs: number, suffix: string][] = [
  [60, 1, "s"],
  [3600, 60, "m"],
  [86400, 3600, "h"],
  [604800, 86400, "d"],
  [2629800, 604800, "w"],
  [31557600, 2629800, "mo"],
  [Infinity, 31557600, "y"],
];

/**
 * Compact relative age of a unix timestamp (seconds), git-log style: `4m ago`,
 * `3d ago`, `2y ago`. Future timestamps — a rebase can date a commit ahead of the
 * clock — read as `just now` rather than negative.
 */
export function timeAgo(timestamp: number, now = Date.now() / 1000): string {
  const elapsed = now - timestamp;
  if (elapsed < 45) return "just now";
  for (const [limit, secs, suffix] of UNITS) {
    if (elapsed < limit) return `${Math.round(elapsed / secs)}${suffix} ago`;
  }
  return "just now";
}
