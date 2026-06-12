/**
 * Single source of truth for the package version.
 *
 * `package.json` must agree with this value.
 *
 * The server uses the `houndsight-` User-Agent prefix to detect SDK callers
 * (HSFIX-3d in `checkLeash`): SDK callers emit their own review-layer step
 * via ingest, so the server skips writing a duplicate server-side step.
 * Keep the prefix stable.
 */

export const VERSION = "0.1.0";

/** User-Agent sent on every HTTP request. The `houndsight-` prefix is load-bearing. */
export const USER_AGENT = `houndsight-node/${VERSION}`;
