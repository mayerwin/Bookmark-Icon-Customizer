// Single source of truth for diagnostic logging.
//
// Toggle to `true` when developing/debugging — the extension will print
// detailed traces of bookmarklet clicks (navigation events, source
// extraction, executeScript outcomes) to the service-worker console.
// Production releases must ship with this `false` so users don't see
// repeated noise every time they click a bookmark.
//
// Set via this constant rather than chrome.storage so it's a build-time
// decision: a CWS user has no way to flip a runtime flag, and we don't
// want to add an unrequested API permission ("management" etc.) just to
// detect dev installs at runtime.
export const BIC_DEBUG = false;

export function bicLog(...args) {
  if (BIC_DEBUG) console.log('[BIC]', ...args);
}
