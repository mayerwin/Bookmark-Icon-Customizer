/**
 * Service worker. Three responsibilities:
 *
 * 1. Heal launcher URLs on install/update/startup so bookmarklet bookmarks
 *    work again after the extension is reinstalled (which mints a fresh
 *    extension ID and invalidates the chrome-extension://<old-id>/launcher
 *    URLs the user had saved).
 *
 * 2. Page-inject bookmarklets: when the user clicks a page-inject-mode
 *    bookmark, the tab navigates to our data:text/html URL. The data: URL
 *    bounces the user back via history.back(); meanwhile we read the
 *    bookmarklet source out of the data: URL's meta tag and chrome.scripting
 *    .executeScript it into the destination page once the back-navigation
 *    commits. End surface is the same as a native javascript: URL.
 *
 *    We detect the data: URL navigation via chrome.webNavigation rather
 *    than chrome.tabs.onUpdated — Chrome scrubs `tab.url` and `info.url`
 *    to the empty string for data:text/html navigations in the tabs API
 *    (no permission grants visibility), but webNavigation always carries
 *    the full URL. webNavigation has no install-time permission warning,
 *    unlike the `tabs` permission which would show "Read your browsing
 *    history" — important for user trust.
 *
 * 3. Complete the apply flow on behalf of the popup when the host-
 *    permission prompt closes the popup mid-await. The popup stashes a
 *    `pendingApply` record before requesting permission; if it survives
 *    the prompt it removes the record and finishes the work itself,
 *    otherwise this listener picks it up.
 */
import {
  healOrphanedLaunchers,
  isBookmarkletDataUrl,
  bookmarkletDataUrlMode,
  bookmarkletDataUrlSource
} from './lib/launcher.js';
import { completePendingApply } from './lib/apply.js';
import { BIC_DEBUG, bicLog } from './lib/debug.js';

// Boot banner — only printed under BIC_DEBUG. Set BIC_DEBUG = true in
// lib/debug.js when debugging click-to-inject failures: the banner shows
// which version is loaded and whether <all_urls> is actually granted.
if (BIC_DEBUG) {
  chrome.permissions.contains({ origins: ['<all_urls>'] }).then(g => {
    bicLog('background v' + chrome.runtime.getManifest().version,
      'started. <all_urls> granted:', g);
  }).catch(() => {});
}

async function runHeal(trigger) {
  try {
    const count = await healOrphanedLaunchers();
    if (count > 0 && BIC_DEBUG) {
      console.info(`[Bookmark Icon Customizer] ${trigger}: restored ${count} bookmarklet(s) whose custom icons were lost.`);
    }
  } catch (e) {
    console.error(`[Bookmark Icon Customizer] heal failed (${trigger}):`, e);
  }
}

chrome.runtime.onInstalled.addListener(() => runHeal('onInstalled'));
chrome.runtime.onStartup.addListener(() => runHeal('onStartup'));

function isRestrictedUrl(url) {
  return !url || url.startsWith('data:') || url.startsWith('chrome-extension://') ||
         url.startsWith('chrome://') || url.startsWith('about:') ||
         url.startsWith('edge://') || url.startsWith('chrome-search://');
}

// Pending page-injects keyed by tabId. The data: URL's webNavigation
// .onCommitted seeds it; the next webNavigation.onCommitted to a real page
// in the same tab consumes it. Held in-memory only — these entries live for
// ≤ a few hundred ms in normal use, and the SW stays alive that long
// because events keep arriving.
const pendingInjects = new Map(); // tabId → { source, expiresAt }

function injectIntoTab(tabId, source) {
  return chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (src) => {
      const s = document.createElement('script');
      s.textContent = src;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    },
    args: [source]
  });
}

function handleNavigation(details) {
  // Main frame only. Sub-frame navigations are unrelated to bookmark clicks.
  if (details.frameId !== 0) return;
  const { tabId, url } = details;

  // 1) Is this our bookmarklet data: URL? Seed the pending inject for this
  //    tab and wait for the user's next navigation back (the data: URL's
  //    script does history.back() immediately).
  if (isBookmarkletDataUrl(url)) {
    if (bookmarkletDataUrlMode(url) !== 'page-inject') return;
    const source = bookmarkletDataUrlSource(url);
    if (!source) {
      console.warn('[Bookmark Icon Customizer] could not extract bookmarklet source from data: URL');
      return;
    }
    bicLog('queued page-inject for tab=' + tabId, 'srcLen=' + source.length);
    pendingInjects.set(tabId, { source, expiresAt: Date.now() + 8000 });
    return;
  }

  // 2) Otherwise, if there's a pending inject for this tab and the URL is
  //    safe to inject into, fire and forget.
  const pending = pendingInjects.get(tabId);
  if (!pending) return;
  if (Date.now() > pending.expiresAt) {
    pendingInjects.delete(tabId);
    return;
  }
  if (isRestrictedUrl(url)) return;
  pendingInjects.delete(tabId);
  bicLog('executing page-inject on', url.slice(0, 80));
  injectIntoTab(tabId, pending.source).then(() => {
    bicLog('page-inject succeeded on tab=' + tabId);
  }).catch(e => {
    console.warn('[Bookmark Icon Customizer] page-inject failed:', e);
  });
}

chrome.webNavigation.onCommitted.addListener(handleNavigation);
// Some Chrome BFCache restores fire only onHistoryStateUpdated (not
// onCommitted) when the previous page is restored from cache. Cover that
// path too so the bookmarklet still runs when the user's previous page
// supports BFCache.
chrome.webNavigation.onHistoryStateUpdated.addListener(handleNavigation);

// Legacy chrome-extension://launcher.html bookmarks built by older versions
// still ship the source via runtime.sendMessage on click — keep this path
// for backward compat until those bookmarks are migrated (re-applying the
// icon converts them to the data: URL form above).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'bic-run-on-prev-page') return;
  if (typeof msg.tabId !== 'number' || typeof msg.code !== 'string') return;
  pendingInjects.set(msg.tabId, { source: msg.code, expiresAt: Date.now() + 8000 });
});

chrome.permissions.onAdded.addListener(async (perms) => {
  // Give the popup a moment to handle this if it's still alive. On
  // successful grant the popup's first act after chrome.permissions.request
  // resolves is to remove `pendingApply`; if it's still here after a short
  // grace window, the popup closed during the prompt (a known Windows
  // behavior with extension action popups under permission modals).
  await new Promise(r => setTimeout(r, 750));

  let pendingApply;
  try {
    ({ pendingApply } = await chrome.storage.session.get('pendingApply'));
  } catch {
    return;
  }
  if (!pendingApply || !pendingApply.permissionPattern) return;
  if (!perms.origins?.includes(pendingApply.permissionPattern)) return;

  // Claim the work so a second onAdded for the same grant (e.g., from a
  // browser-state replay) can't double-fire the completion.
  await chrome.storage.session.remove('pendingApply');
  try {
    await completePendingApply(pendingApply);
    bicLog('apply completed in background after popup closed during permission grant.');
  } catch (e) {
    console.error('[Bookmark Icon Customizer] Background apply failed:', e);
  }
});
