/**
 * Bookmarklet launcher URL helpers and self-healing.
 *
 * javascript: bookmarks get rewritten to
 *   chrome-extension://<id>/launcher.html?js=<encodeURIComponent(source)>
 * so they can carry a favicon (see launcher.html / launcher.js). The
 * original source is preserved verbatim in the `js` param; users can
 * always recover it by decoding, even if this extension is gone.
 *
 * Two things make that URL fragile across the extension lifecycle:
 *
 *   1. Uninstalling + reinstalling gives the extension a fresh ID, so
 *      existing launcher URLs point at a dead chrome-extension://OLD_ID.
 *   2. chrome.storage.local is wiped when the extension is removed, so
 *      the custom-icon mapping for each URL is also gone.
 *
 * Both are recoverable: we walk the bookmark tree, find launcher URLs
 * whose mapping is missing (different ID or same ID + empty storage),
 * and restore them to their original javascript: form. The user loses
 * the custom icon — that data is genuinely gone — but the bookmarklet
 * itself keeps working, and they can re-customize any time.
 */
import StorageService from './storage.js';

export const LAUNCHER_PATH = '/launcher.html';

// Sentinel prefix that marks a launcher whose body is a webhook-trigger fetch.
// Lets launcherOriginalUrl() reconstruct the original https URL after an
// uninstall/reinstall (when the storage mapping has been wiped).
const WEBHOOK_MARKER = '/*BIC-WEBHOOK*/';
const WEBHOOK_JS_RE = /^\/\*BIC-WEBHOOK\*\/fetch\(("(?:[^"\\]|\\.)*")/;

// Sentinel prefix that marks a launcher whose body must run against the
// page the user clicked the bookmark from (not the sandbox iframe). When
// the launcher boots in page-inject mode it hands the JS off to background.js
// via chrome.runtime.sendMessage, then history.back()s the tab to the user's
// previous page; background then chrome.scripting.executeScript's the code
// into the now-active tab's MAIN world. Requires <all_urls> host permission,
// requested in the popup at apply time and gated by the picker's
// "Run on the current page" toggle.
const PAGE_INJECT_MARKER = '/*BIC-PAGE-INJECT*/';

// Decode percent-escapes until the string stops changing. Chrome's bookmark
// storage normalizes javascript: URLs by percent-encoding parts of the body
// (e.g., space → %20, ` → %60). When we read `bm.url` we get that already-
// encoded form back; a single encodeURIComponent on top of it then produces
// %2520, %2560 etc. — the launcher would eval corrupted JS. Iterating until
// stable also recovers legacy bookmarks that were saved with the buggy
// double-encoded URL. Capped at 5 to bound runaway input.
//
// We decode per contiguous %XX run via String.replace instead of calling
// decodeURIComponent on the whole string, because bookmarklets routinely
// contain literal `%` characters (CSS `100%`, JS `String.fromCharCode(37)`
// dumps, etc.) that show up as `%` + non-hex once the URL has been decoded
// one level. decodeURIComponent on the whole string throws on those — and
// the previous catch-and-break left every still-encoded %20 from a
// double-encoded URL untouched, so re-encoding produced %2520 in the
// output. The per-run decoder leaves invalid runs alone and keeps
// stripping the valid ones.
//
// Each contiguous run is decoded as a single unit so multi-byte UTF-8
// sequences (e.g., %E2%80%9C for a curly quote) stay together.
export function recursivelyDecode(s) {
  let cur = s;
  for (let i = 0; i < 5; i++) {
    const next = cur.replace(/(?:%[0-9A-Fa-f]{2})+/g, run => {
      try { return decodeURIComponent(run); } catch { return run; }
    });
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

// Marker + meta tag used by data: URL webhook bookmarks. Chrome substitutes
// its own manifest icon for any chrome-extension:// bookmark, ignoring the
// <link rel="icon"> the page sets. data:text/html bookmarks dodge that —
// the favicon data URI is embedded inline and Chrome shows it as-is.
const WEBHOOK_DATA_MARKER = '<!--BIC-WEBHOOK-->';
const WEBHOOK_DATA_META_RE = /<meta name="bic-webhook-target" content="([^"]+)">/;

// Marker + meta tags used by data: URL bookmarklet bookmarks. Same favicon
// argument as webhooks above: Chrome ignores <link rel="icon"> on
// chrome-extension://launcher.html so we can't make the launcher page
// carry a custom favicon on the bookmark bar. data:text/html bookmarks
// inline the favicon and Chrome honors it.
const BOOKMARKLET_DATA_MARKER = '<!--BIC-BOOKMARKLET-->';
const BOOKMARKLET_DATA_MODE_RE = /<meta name="bic-bookmarklet-mode" content="([^"]+)">/;
const BOOKMARKLET_DATA_SOURCE_RE = /<meta name="bic-bookmarklet-source" content="([^"]+)">/;

export function isLauncherUrl(urlString) {
  try {
    const u = new URL(urlString);
    return u.protocol === 'chrome-extension:' &&
           u.hostname === chrome.runtime.id &&
           u.pathname === LAUNCHER_PATH;
  } catch { return false; }
}

export function buildLauncherUrl(jsSource) {
  return `${chrome.runtime.getURL(LAUNCHER_PATH)}?js=${encodeURIComponent(recursivelyDecode(jsSource))}`;
}

/**
 * Build the JS body for a webhook-trigger launcher. The fetch uses
 * `keepalive: true` so the request survives the launcher tab closing
 * right after dispatch, and `mode: 'no-cors'` so CORS headers aren't
 * required from the webhook server.
 */
export function buildWebhookJs(targetUrl) {
  return `${WEBHOOK_MARKER}fetch(${JSON.stringify(targetUrl)},{mode:'no-cors',keepalive:true}).catch(()=>{})`;
}

/** Extract the original webhook URL from a launcher URL, if it encodes one. */
export function launcherWebhookUrl(launcherUrl) {
  try {
    const js = new URL(launcherUrl).searchParams.get('js') || '';
    const m = js.match(WEBHOOK_JS_RE);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  } catch { return null; }
}

/**
 * Wrap a raw bookmarklet source so the launcher runs it on the user's
 * page (their previous tab) rather than the sandbox iframe. The marker
 * is recognized by launcher.js and stripped before the JS is dispatched
 * to background.js. Stays as plain text inside the launcher URL's js=
 * param so launcherOriginalUrl() can also recover the original.
 */
export function buildPageInjectJs(jsSource) {
  return `${PAGE_INJECT_MARKER}${jsSource}`;
}

/**
 * If `launcherUrl` is a page-inject launcher, return the bookmarklet
 * source with the marker stripped. Otherwise null. URLSearchParams.get
 * already decodes one level; recursivelyDecode unwraps any legacy
 * double-encoding before the marker check.
 */
export function launcherPageInjectCode(launcherUrl) {
  try {
    const js = recursivelyDecode(new URL(launcherUrl).searchParams.get('js') || '');
    if (!js.startsWith(PAGE_INJECT_MARKER)) return null;
    return js.slice(PAGE_INJECT_MARKER.length);
  } catch { return null; }
}

function decodeDataHtml(url) {
  if (typeof url !== 'string' || !url.startsWith('data:text/html')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  try { return decodeURIComponent(url.slice(comma + 1)); } catch { return null; }
}

/** True if the URL is a data:text/html webhook bookmark built by this extension. */
export function isWebhookDataUrl(url) {
  const html = decodeDataHtml(url);
  return !!html && html.includes(WEBHOOK_DATA_MARKER);
}

/** Extract the original webhook URL from a data: webhook bookmark, if any. */
export function webhookDataTargetUrl(url) {
  const html = decodeDataHtml(url);
  if (!html || !html.includes(WEBHOOK_DATA_MARKER)) return null;
  const m = html.match(WEBHOOK_DATA_META_RE);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

/** Extract the embedded favicon data URI from a data: webhook bookmark. */
export function webhookDataIconUrl(url) {
  const html = decodeDataHtml(url);
  if (!html || !html.includes(WEBHOOK_DATA_MARKER)) return null;
  const m = html.match(/<link rel="icon"[^>]*href="([^"]+)"/);
  return m ? m[1] : null;
}

/** True if the URL is a data:text/html bookmarklet bookmark built by this extension. */
export function isBookmarkletDataUrl(url) {
  const html = decodeDataHtml(url);
  return !!html && html.includes(BOOKMARKLET_DATA_MARKER);
}

/** Returns 'sandbox' | 'page-inject' | null. */
export function bookmarkletDataUrlMode(url) {
  const html = decodeDataHtml(url);
  if (!html || !html.includes(BOOKMARKLET_DATA_MARKER)) return null;
  const m = html.match(BOOKMARKLET_DATA_MODE_RE);
  return m ? m[1] : null;
}

/** Extract the original bookmarklet JS source from a data: bookmarklet bookmark. */
export function bookmarkletDataUrlSource(url) {
  const html = decodeDataHtml(url);
  if (!html || !html.includes(BOOKMARKLET_DATA_MARKER)) return null;
  const m = html.match(BOOKMARKLET_DATA_SOURCE_RE);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

/** Extract the embedded favicon data URI from a data: bookmarklet bookmark. */
export function bookmarkletDataUrlIconUrl(url) {
  const html = decodeDataHtml(url);
  if (!html || !html.includes(BOOKMARKLET_DATA_MARKER)) return null;
  const m = html.match(/<link rel="icon"[^>]*href="([^"]+)"/);
  return m ? m[1] : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

/**
 * Build a data:text/html bookmark URL that triggers `targetUrl` as a
 * background fetch and carries `iconDataUrl` as its favicon. The icon is
 * inlined in the HTML so Chrome displays it on the bookmark bar without
 * any priming — which is why we use this instead of the chrome-extension
 * launcher for webhooks (Chrome overrides extension-URL favicons with the
 * manifest icon).
 *
 * The original target URL is embedded in a meta tag so we can reconstruct
 * it later (for the picker's "webhook URL" display and for untick-to-revert).
 */
/**
 * Build a data:text/html bookmark URL for a bookmarklet, carrying
 * `iconDataUrl` as its favicon (inlined so Chrome shows it on the bookmark
 * bar — `chrome-extension://launcher.html` can't, Chrome substitutes the
 * extension's manifest icon there).
 *
 * Two modes, picked by `opts.pageInject`:
 *
 * - **sandbox** (default): the user's JS runs inside the data: URL itself
 *   when the bookmark is clicked, then the tab history-backs. Useful for
 *   fire-and-forget bookmarklets that don't need the previous page (open
 *   a URL, ping a server, etc.). No extra permission required.
 *
 * - **page-inject** (`opts.pageInject === true`): the data: URL just
 *   bounces the user back to their previous page; background.js detects
 *   the BOOKMARKLET_DATA_MARKER navigation via chrome.webNavigation,
 *   extracts the source from the meta tag, and
 *   chrome.scripting.executeScript's it into the now-active tab's MAIN
 *   world. Same execution surface a native javascript: URL has. Requires
 *   the optional `webNavigation` permission and `<all_urls>` host
 *   permission, both requested at apply time so neither triggers an
 *   install-time warning.
 *
 * The original JS source is stored URL-encoded in a meta tag so the popup
 * can recover it (restore original, toggle mode, change icon) and so
 * background.js can read it during page-inject.
 */
export function buildBookmarkletDataUrl(jsSource, iconDataUrl, title, opts = {}) {
  const pageInject = !!opts.pageInject;
  const safeTitle = escapeHtml(title || 'Bookmarklet');
  const icon = iconDataUrl || '';
  const encodedSource = encodeURIComponent(jsSource);
  const mode = pageInject ? 'page-inject' : 'sandbox';
  const statusText = pageInject ? 'Running bookmarklet on previous page…' : 'Running bookmarklet…';
  const backDelay = pageInject ? 30 : 150;
  // Sandbox mode: read the source out of the meta tag and run it as a
  // fresh <script> element. Avoids the </script>-escape minefield of
  // inlining the source directly, and avoids eval / new Function (which
  // some pages' CSP — though not data: URLs — refuse to allow).
  const inlineRun = pageInject ? '' :
    `var m=document.querySelector('meta[name="bic-bookmarklet-source"]');` +
    `if(m){var s=document.createElement('script');` +
    `s.textContent=decodeURIComponent(m.content);` +
    `(document.head||document.documentElement).appendChild(s);s.remove();}`;
  const navigateBack =
    `setTimeout(function(){if(history.length>1){try{history.back();}catch(e){}}` +
    `else{try{window.close();}catch(e){}}},${backDelay});`;
  const html =
    `<!DOCTYPE html><html><head>${BOOKMARKLET_DATA_MARKER}` +
    `<meta charset="utf-8">` +
    `<meta name="bic-bookmarklet-mode" content="${mode}">` +
    `<meta name="bic-bookmarklet-source" content="${encodedSource}">` +
    `<title>${safeTitle}</title>` +
    `<link rel="icon" type="image/png" href="${icon}">` +
    `<style>html,body{margin:0;background:#111;color:#ddd;font:14px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}</style>` +
    `</head><body><div>${statusText}</div>` +
    `<script>${inlineRun}${navigateBack}</script>` +
    `</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function buildWebhookDataUrl(targetUrl, iconDataUrl, title) {
  const safeTitle = escapeHtml(title || 'Webhook');
  const safeTarget = escapeHtml(encodeURIComponent(targetUrl));
  const icon = iconDataUrl || '';
  // Escape </ inside the JSON literal so a maliciously-crafted URL can't
  // close the <script> tag prematurely.
  const targetLiteral = JSON.stringify(targetUrl).replace(/<\//g, '<\\/');
  const html =
    `<!DOCTYPE html><html><head>${WEBHOOK_DATA_MARKER}` +
    `<meta charset="utf-8">` +
    `<meta name="bic-webhook-target" content="${safeTarget}">` +
    `<title>${safeTitle}</title>` +
    `<link rel="icon" type="image/png" href="${icon}">` +
    `<style>html,body{margin:0;background:#111;color:#ddd;font:14px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}</style>` +
    `</head><body><div>Triggering webhook…</div>` +
    // After firing the webhook, send the user back. history.back() first
    // restores the page they clicked from (their tab navigated here);
    // window.close() is only the right call when there's no previous
    // page in this tab (history.length === 1 during priming, where our
    // external closer removes the window anyway). Calling close() first
    // is unsafe in current Chrome — it destroys user-initiated tabs.
    `<script>fetch(${targetLiteral},{mode:'no-cors',keepalive:true}).catch(()=>{});` +
    `setTimeout(function(){if(history.length>1){try{history.back();}catch(e){}}else{try{window.close();}catch(e){}}},150);</script>` +
    `</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function launcherOriginalUrl(launcherUrl) {
  // Webhook-converted launchers restore to their original https URL so the
  // bookmark keeps working normally after uninstall, without the user having
  // to decode anything.
  const webhook = launcherWebhookUrl(launcherUrl);
  if (webhook) return webhook;
  try {
    // URLSearchParams.get already decodes one level; recursivelyDecode
    // strips any leftover encoding from legacy double-encoded launcher
    // URLs so the restored javascript: URL holds the raw bookmarklet.
    let js = recursivelyDecode(new URL(launcherUrl).searchParams.get('js') || '');
    // Page-inject launchers carry a marker prefix the user never saw; strip
    // it so the restored javascript: URL is byte-identical to what they had.
    if (js.startsWith(PAGE_INJECT_MARKER)) js = js.slice(PAGE_INJECT_MARKER.length);
    return `javascript:${js}`;
  } catch { return 'javascript:'; }
}

function isOrphanLauncher(urlString, mappings) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'chrome-extension:') return false;
    if (u.pathname !== LAUNCHER_PATH) return false;
    if (!u.searchParams.has('js')) return false;
    // Different extension ID — from a previous install, now dead.
    if (u.hostname !== chrome.runtime.id) return true;
    // Same ID but no storage mapping — storage was wiped or edited.
    return !mappings[urlString];
  } catch { return false; }
}

export async function healOrphanedLaunchers() {
  const [tree, mappings] = await Promise.all([
    chrome.bookmarks.getTree(),
    StorageService.getMappings()
  ]);
  const orphans = [];
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.url && isOrphanLauncher(n.url, mappings)) orphans.push(n);
      if (n.children) walk(n.children);
    }
  })(tree);
  let healed = 0;
  for (const n of orphans) {
    try {
      await chrome.bookmarks.update(n.id, { url: launcherOriginalUrl(n.url) });
      healed++;
    } catch (e) {
      console.warn('heal: could not update bookmark', n.id, e);
    }
  }
  return healed;
}
