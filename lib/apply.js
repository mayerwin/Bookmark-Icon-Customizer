/**
 * Shared post-permission apply pipeline.
 *
 * The popup owns the picker UI, so it computes apply parameters and
 * requests host permission. Everything after the permission grant —
 * bookmark URL update, mapping write, content-script (re)registration,
 * origin revocation, and favicon priming — lives here so both the popup
 * (alive case) and background.js (popup-died-during-prompt case) run
 * identical code.
 *
 * The popup-died case is real on Windows: chrome.permissions.request
 * pops a modal that can steal focus from the extension action popup,
 * which Chrome then closes. The await never resolves in the popup, so
 * the post-permission work never ran — the user was forced to click
 * Apply a second time. background.js's chrome.permissions.onAdded
 * listener now calls completePendingApply() to finish the job.
 */
import StorageService from './storage.js';

export const CONTENT_SCRIPT_ID = 'bookmark-favicon-override';

// Build a match pattern limited to the URL's origin. Content scripts can only
// be registered for origins the user has explicitly granted us.
export function originMatchPattern(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

// Keep the single registered content script in sync with storage + permissions.
// Idempotent — safe to call from either popup or background after a grant or
// a revoke, and on popup open as a heal-on-launch step.
export async function syncContentScripts() {
  const mappings = await StorageService.getMappings();

  const allowed = [];
  const seen = new Set();
  for (const url of Object.keys(mappings)) {
    const p = originMatchPattern(url);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (await chrome.permissions.contains({ origins: [p] })) allowed.push(p);
  }

  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  const isRegistered = existing.length > 0;

  if (allowed.length === 0) {
    if (isRegistered) {
      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    }
    return;
  }

  const config = {
    id: CONTENT_SCRIPT_ID,
    matches: allowed,
    js: ['content_script.js'],
    runAt: 'document_start',
    allFrames: false,
    persistAcrossSessions: true
  };

  if (isRegistered) {
    await chrome.scripting.updateContentScripts([config]);
  } else {
    await chrome.scripting.registerContentScripts([config]);
  }
}

// Revoke the origin permission if no other customized URL still needs it.
// Best-effort: chrome.permissions.remove can reject on some origin patterns
// and we don't want that to surface as a user-facing error.
export async function maybeRevokeOrigin(url) {
  const pattern = originMatchPattern(url);
  if (!pattern) return;
  const mappings = await StorageService.getMappings();
  const stillNeeded = Object.keys(mappings).some(u => originMatchPattern(u) === pattern);
  if (stillNeeded) return;
  try {
    await chrome.permissions.remove({ origins: [pattern] });
  } catch (e) {
    console.warn('Permission revoke failed (non-critical):', e);
  }
}

// Load the bookmark URL once so Chrome fetches the favicon our content script
// (for http(s)) or launcher.js (for bookmarklets) sets, and caches it against
// this URL. Without this, the bookmark bar icon only updates on the user's
// next manual visit.
//
// Two rendering targets:
//   • useWindow: true — opens a small unfocused popup window (chrome.windows
//     .create with type: 'popup'). Real windows run the full page lifecycle,
//     so Chrome's favicon cache updates reliably. Background tabs sometimes
//     failed to cache the favicon, leaving the bookmark bar icon stale and
//     making the extension look broken.
//   • useWindow: false — a background tab. Good enough for our own launcher
//     pages, which are tiny and predictable.
//
// The priming URL is byte-identical to the URL stored against the bookmark.
// Chrome's favicon cache keys include the query string, so any extra
// `?mode=prime` or `#prime` marker would split the cache entry and the
// bookmark bar wouldn't find the icon. For bookmarklets, we instead signal
// "don't run the JS" via chrome.storage.session — launcher.js reads that
// flag on load.
//
// For http(s) URLs we also imperatively inject content_script.js via
// chrome.scripting.executeScript as soon as the priming tab commits.
// Background: on the very first apply for a newly-granted origin, the
// chrome.scripting.registerContentScripts call set up moments earlier
// (right after chrome.permissions.request resolved) doesn't always reach
// Chrome's content-script registry before the popup's initial navigation
// begins — so the registered injection misses the priming load and the
// bookmark bar icon stays stale until the user re-applies. Direct
// executeScript closes that race. content_script.js is idempotent
// (window-level guard), so double-injection is harmless.
export async function primeFaviconCache(url, { useWindow = false } = {}) {
  await chrome.storage.session.set({ primingUrl: url });

  let tabId;
  let closer;
  try {
    if (useWindow) {
      const win = await chrome.windows.create({
        url,
        type: 'popup',
        width: 520,
        height: 400,
        focused: false
      });
      tabId = win.tabs?.[0]?.id;
      closer = async () => { try { await chrome.windows.remove(win.id); } catch { /* gone */ } };
    } else {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab?.id;
      closer = async () => { try { await chrome.tabs.remove(tabId); } catch { /* gone */ } };
    }
  } catch (e) {
    console.warn('Priming failed:', e);
    await chrome.storage.session.remove('primingUrl');
    return;
  }

  if (!tabId) {
    await chrome.storage.session.remove('primingUrl');
    return;
  }

  const needsInject = /^https?:/.test(url);

  try {
    await new Promise(resolve => {
      let settled = false;
      let injected = !needsInject;
      const tryInject = () => {
        if (injected) return;
        injected = true;
        chrome.scripting.executeScript({
          target: { tabId },
          files: ['content_script.js'],
          injectImmediately: true
        }).catch(e => {
          // Tab may not have fully committed yet, or another transient
          // condition — allow a later update event to retry.
          injected = false;
          console.warn('Priming inject failed, will retry on next update:', e);
        });
      };
      const finish = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
      const onUpdated = (updatedTabId, info) => {
        if (updatedTabId !== tabId) return;
        // Inject as early as the navigation commits. Don't trigger on
        // info.url alone — popup windows can fire a URL-set event for
        // about:blank during the initial transition, and we'd burn the
        // (single) inject attempt on a frame we don't have permission for.
        if (!injected && info.status === 'loading') tryInject();
        if (info.status === 'complete') {
          // Last-chance injection if 'loading' was missed (rare).
          tryInject();
          // Windowed priming gets a slightly longer buffer — real pages
          // often fire 'complete' before they've painted their favicon.
          setTimeout(finish, useWindow ? 900 : 400);
        }
      };
      const onRemoved = removedTabId => { if (removedTabId === tabId) finish(); };
      const cleanup = () => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
      // Immediate attempt: chrome.windows.create can resolve after the
      // tab has already fired its first 'loading' event, so the listener
      // above would miss it. If the tab is still at about:blank during
      // the transition, this attempt fails (no permission), the catch
      // resets `injected`, and the next onUpdated event retries.
      tryInject();
      // Hard cap — slow/hanging pages shouldn't lock up the UI.
      setTimeout(finish, useWindow ? 10000 : 6000);
    });
    await closer();
  } finally {
    await chrome.storage.session.remove('primingUrl');
  }
}

/**
 * Run the post-permission part of the apply flow: bookmark URL migration,
 * mapping write, content-script (re)registration, optional origin revoke,
 * and favicon priming. Idempotent — safe if the popup and background race
 * (both honour the same chrome.storage.session.pendingApply hand-off, and
 * the worst case is the priming window opens twice for ~1s each).
 *
 * `pending` shape (set by popup.js applyCustomization before requesting
 * permission, read by background.js permissions.onAdded handler):
 *   {
 *     bookmarkId:           chrome.bookmarks node id
 *     newBookmarkUrl:       string | null — URL to set via bookmarks.update
 *     oldMappingKey:        string | null — old chrome.storage mapping key to drop
 *     storageKey:           string — new chrome.storage mapping key
 *     customIcon:           string (data: URL) — icon to save
 *     title:                string — bookmark title to save with mapping
 *     originToMaybeRevoke:  string | null — URL whose origin we may release
 *     useWindow:            boolean — passed to primeFaviconCache
 *     permissionPattern:    string | null — match pattern that gated this apply
 *   }
 */
export async function completePendingApply(pending) {
  const {
    bookmarkId,
    newBookmarkUrl,
    oldMappingKey,
    storageKey,
    customIcon,
    title,
    originToMaybeRevoke,
    useWindow
  } = pending;

  if (newBookmarkUrl) {
    try {
      await chrome.bookmarks.update(bookmarkId, { url: newBookmarkUrl });
    } catch (e) {
      console.warn('Bookmark URL update failed (non-fatal):', e);
    }
  }

  if (oldMappingKey && oldMappingKey !== storageKey) {
    await StorageService.removeMapping(oldMappingKey);
  }

  await StorageService.saveMapping(storageKey, { customIcon, title });

  await syncContentScripts();
  if (originToMaybeRevoke) await maybeRevokeOrigin(originToMaybeRevoke);

  await primeFaviconCache(storageKey, { useWindow });
}
