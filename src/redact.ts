// Every URL that leaves this process for a log, a recording header or the
// dashboard goes through redact(). Keys sit in query strings (Solami takes
// ?api_key=, many RPC hosts put the key in the path), so both are masked.

const QUERY_KEYS = /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|x-token)=)[^&#\s]+/gi;
// A long opaque path segment (>= 20 chars of [A-Za-z0-9_-]) is treated as a key.
const PATH_KEY = /\/([A-Za-z0-9_-]{20,})(?=\/|$|\?|#)/g;

export function redact(text: string): string {
  return text.replace(QUERY_KEYS, '$1***').replace(PATH_KEY, '/***');
}

/** The host part, for labels on the dashboard. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid url)';
  }
}
