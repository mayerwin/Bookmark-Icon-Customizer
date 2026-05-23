/**
 * Bookmarklet launcher — replaces javascript: bookmarks so they can have
 * custom favicons. Chrome's favicon cache only works for pages that load,
 * so we host a real extension page and encode the original JS as a URL
 * parameter. If this extension is ever removed, the user can decode the
 * `js` query param to recover their original bookmarklet verbatim.
 *
 * Three operating modes, picked off the js= source:
 *
 *   - Webhook (starts with /*BIC-WEBHOOK*​/): a fire-and-forget fetch() to
 *     a server endpoint. Runs inside the sandbox iframe because the body
 *     is just a fetch — no DOM access needed.
 *
 *   - Page-inject (starts with /*BIC-PAGE-INJECT*​/): a real bookmarklet
 *     that needs to modify the page the user clicked it from (add a
 *     button, edit content, read selection, etc.). The launcher hands the
 *     stripped source off to background.js via chrome.runtime.sendMessage
 *     and history.back()s the tab, returning the user to their previous
 *     page. background.js then uses chrome.scripting.executeScript with
 *     world: 'MAIN' to run the code in that page's actual JS context —
 *     same surface a native javascript: URL would have. Requires
 *     <all_urls> host permission, requested in the popup at apply time.
 *
 *   - Sandbox (no marker): bookmarklets that don't depend on the current
 *     page (open a URL, copy something to clipboard via the launcher tab,
 *     etc.). We eval inside the sandbox iframe — MV3's extension_pages
 *     CSP forbids eval on the launcher itself, so the sandbox is what
 *     lets arbitrary user code run at all.
 *
 * Priming: when the popup applies a new icon it opens this page in a
 * background tab at the exact same URL the bookmark stores, so Chrome
 * caches the favicon against that cache key. The popup sets
 * chrome.storage.session.primingUrl just before opening the tab; we read
 * that flag here and skip JS execution so the user's bookmarklet doesn't
 * run as a side effect of applying an icon. Storing the signal in session
 * storage (rather than in the URL) lets the priming URL be byte-identical
 * to the bookmark URL — essential for the favicon cache to line up.
 */
import { recursivelyDecode } from './lib/launcher.js';

const params = new URLSearchParams(window.location.search);
// recursivelyDecode unwraps any leftover percent-encoding from launcher URLs
// saved by older builds that double-encoded the js= parameter. Modern builds
// produce single-encoded URLs, so it's a no-op for those.
const jsSource = recursivelyDecode(params.get('js') || '');
const WEBHOOK_MARKER = '/*BIC-WEBHOOK*/';
const PAGE_INJECT_MARKER = '/*BIC-PAGE-INJECT*/';
const isWebhook = jsSource.startsWith(WEBHOOK_MARKER);
const isPageInject = jsSource.startsWith(PAGE_INJECT_MARKER);
if (isWebhook) {
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = 'Triggering webhook…';
} else if (isPageInject) {
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = 'Running bookmarklet on previous page…';
}

// Track the sandbox iframe's load state from the very first tick so we
// don't race with launcher.js's own async work (storage read, favicon).
const sandboxIframe = document.getElementById('sandbox');
let sandboxLoaded = false;
sandboxIframe.addEventListener('load', () => { sandboxLoaded = true; });

async function isPrimingLoad() {
  try {
    const { primingUrl } = await chrome.storage.session.get('primingUrl');
    return primingUrl === window.location.href;
  } catch {
    return false;
  }
}

async function setFavicon() {
  const key = window.location.href;
  const { bookmark_icons: mappings = {} } = await chrome.storage.local.get('bookmark_icons');
  const entry = mappings[key];
  if (entry && entry.customIcon) {
    document.getElementById('favicon').href = entry.customIcon;
    if (entry.title) document.title = entry.title;
  }
}

function runInSandbox(code) {
  return new Promise(resolve => {
    let settled = false;
    let posted = false;
    const done = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const onMsg = e => {
      if (e.source === sandboxIframe.contentWindow && e.data && e.data.type === 'sandbox-done') done();
    };
    const cleanup = () => window.removeEventListener('message', onMsg);
    window.addEventListener('message', onMsg);

    const post = () => {
      if (posted) return;
      posted = true;
      sandboxIframe.contentWindow.postMessage({ type: 'exec', code }, '*');
    };
    // Belt-and-suspenders: modules are deferred, so the iframe's load event
    // may have fired before we got here. Fire on load OR after a short grace
    // period, whichever comes first. `posted` guards against double exec.
    sandboxIframe.addEventListener('load', post, { once: true });
    if (sandboxLoaded) post();
    else setTimeout(post, 200);

    // Hard cap — if the sandbox never reports back (syntax error, infinite
    // loop, etc.), close anyway so the window doesn't linger.
    setTimeout(done, 3000);
  });
}

// Hand off page-inject mode to background.js: tell it which tab to inject
// into and what code to run, then bail. background watches for the tab's
// next navigation away from launcher.html and runs the code in the new
// page's MAIN world. Synchronous send + immediate history.back() is fine
// — Chrome queues the message before the launcher document unloads.
async function dispatchPageInject(code) {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (!tab || tab.id == null) return;
    chrome.runtime.sendMessage({
      type: 'bic-run-on-prev-page',
      tabId: tab.id,
      code
    });
  } catch (e) {
    console.warn('[BIC] page-inject dispatch failed:', e);
  }
}

async function main() {
  const priming = await isPrimingLoad();
  await setFavicon();
  // Priming mode: the popup opened us to warm Chrome's favicon cache.
  // It will close this tab itself once Chrome has picked up the favicon.
  if (priming) return;

  if (isPageInject) {
    // Hand off to background, then immediately navigate back — the
    // background-side script.executeScript runs once the tab commits to
    // the previous URL. Skip the sandbox entirely; running the code there
    // first would be both pointless (sandbox DOM ≠ user's page) and a
    // double-execution risk.
    await dispatchPageInject(jsSource.slice(PAGE_INJECT_MARKER.length));
  } else if (jsSource) {
    await runInSandbox(jsSource);
  }
  // Brief pause so any fire-and-forget fetch hands off to the network
  // stack before we navigate away. Then return the user to where they
  // came from: clicking the bookmark navigated their existing tab here,
  // so history.back() restores their previous page. window.close() is
  // only correct when there's no previous page (e.g., middle-clicked
  // into a new tab) — Chrome now honors window.close() on extension
  // pages even for user-initiated navigations, so calling it first
  // would destroy the user's tab and lose whatever they were doing.
  setTimeout(() => {
    if (history.length > 1) {
      try { history.back(); } catch (e) { /* nothing else to do */ }
    } else {
      try { window.close(); } catch (e) { /* nothing else to do */ }
    }
  }, isPageInject ? 30 : 150);
}

main();
