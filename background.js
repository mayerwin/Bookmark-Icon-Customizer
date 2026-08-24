/**
 * Service worker. Three responsibilities:
 *
 * 1. Heal launcher URLs on install/update/startup so bookmarklet bookmarks
 *    work again after the extension is reinstalled (which mints a fresh
 *    extension ID and invalidates the chrome-extension://<old-id>/launcher
 *    URLs the user had saved).
 *
 * 2. Page-inject bookmarklets: when the user clicks a page-inject-mode
 *    bookmark, the tab navigates to our data:text/html URL, which calls
 *    history.back() and lands the user back on their previous page. We
 *    watch the navigation via chrome.webNavigation, recognise our URL by
 *    its embedded marker, read the bookmarklet source from its meta tag,
 *    and chrome.scripting.executeScript it into the destination page once
 *    the back-navigation commits. Same execution surface as a native
 *    javascript: URL.
 *
 *    The webNavigation permission is declared as `optional_permissions`
 *    so it doesn't trigger Chrome's "Read your browsing history" warning
 *    on install. The popup requests it (alongside <all_urls> host
 *    permission) only when the user first ticks "Run on the current page"
 *    and applies — contextually, when the user is opting into the feature
 *    that requires it. Users who never use page-inject mode never see the
 *    prompt at all.
 *
 *    Both listeners are registered at top level (MV3 requires it for the
 *    SW to wake on those events) but they no-op gracefully if the
 *    permission hasn't been granted yet — chrome.webNavigation.onCommitted
 *    will simply never fire in that case.
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

if (BIC_DEBUG) {
  Promise.all([
    chrome.permissions.contains({ origins: ['<all_urls>'] }),
    chrome.permissions.contains({ permissions: ['webNavigation'] })
  ]).then(([urls, wn]) => {
    bicLog('background v' + chrome.runtime.getManifest().version,
      'started. <all_urls>=' + urls, 'webNavigation=' + wn);
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

const pendingInjects = new Map(); // tabId → { source, expiresAt }

function injectIntoTab(tabId, source) {
  return chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (src) => {
      // Pages that enforce `require-trusted-types-for 'script'` (youtube.com
      // and most Google properties) make HTMLScriptElement.textContent a
      // Trusted Types sink: assigning a plain string throws before the
      // <script> is ever appended, so the bookmarklet silently never runs and
      // the user just sees the tab bounce away and back. MAIN-world injections
      // are subject to the page's CSP — only isolated-world content scripts
      // are exempt — so we mint a pass-through policy and wrap the source.
      //
      // No new permission: Trusted Types is a plain web-platform API. Pages
      // that don't enforce it are unaffected (the policy is an identity
      // function, and a TrustedScript assigns to textContent exactly like the
      // string did). The policy is cached on the page so repeated clicks —
      // including bfcache restores, which bring the same document back — don't
      // re-mint it, which would throw under a `trusted-types` directive that
      // doesn't allow duplicates.
      let payload = src;
      try {
        const tt = window.trustedTypes;
        if (tt && tt.createPolicy) {
          let policy = window.__BIC_TT_POLICY__;
          if (!policy) {
            try {
              policy = tt.createPolicy('bic-bookmarklet', { createScript: (s) => s });
            } catch (e) {
              // A `trusted-types` directive that doesn't allowlist our name
              // rejects the policy; the page's own default policy, if it has
              // one, is the next best thing.
              policy = tt.defaultPolicy || null;
            }
            if (policy) window.__BIC_TT_POLICY__ = policy;
          }
          if (policy) payload = policy.createScript(src);
        }
      } catch (e) {
        payload = src; // fall through and let the raw assignment try its luck
      }
      const s = document.createElement('script');
      s.textContent = payload;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    },
    args: [source]
  });
}

function handleNavigation(details) {
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

// Register the listeners unconditionally. If webNavigation isn't granted
// yet, they simply never fire — that's fine because the popup only lets
// the user apply a page-inject bookmarklet after granting the permission.
if (chrome.webNavigation) {
  chrome.webNavigation.onCommitted.addListener(handleNavigation);
  chrome.webNavigation.onHistoryStateUpdated.addListener(handleNavigation);
}

// Apply-flow fallback: if the popup closes during a permission prompt,
// finish the work here when the permission lands.
chrome.permissions.onAdded.addListener(async (perms) => {
  await new Promise(r => setTimeout(r, 750));
  let pendingApply;
  try {
    ({ pendingApply } = await chrome.storage.session.get('pendingApply'));
  } catch {
    return;
  }
  if (!pendingApply) return;
  // Match either a host pattern grant (for http(s) bookmarks) or a
  // permission grant (for page-inject bookmarklets, which need
  // webNavigation + <all_urls>). The popup stashes whatever set of
  // grants it was waiting on.
  const hostOk = !pendingApply.permissionPattern ||
    perms.origins?.includes(pendingApply.permissionPattern);
  const apiOk = !pendingApply.permissionNames ||
    pendingApply.permissionNames.every(p => perms.permissions?.includes(p));
  if (!hostOk && !apiOk) return;

  await chrome.storage.session.remove('pendingApply');
  try {
    await completePendingApply(pendingApply);
    bicLog('apply completed in background after popup closed during permission grant.');
  } catch (e) {
    console.error('[Bookmark Icon Customizer] Background apply failed:', e);
  }
});
