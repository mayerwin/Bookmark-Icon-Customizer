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

// Decode percent-escapes until the string stops changing. Chrome's bookmark
// storage normalizes javascript: URLs by percent-encoding parts of the body
// (e.g., space → %20, ` → %60). When we read `bm.url` we get that already-
// encoded form back; a single encodeURIComponent on top of it then produces
// %2520, %2560 etc. — the launcher would eval corrupted JS. Iterating until
// stable also recovers legacy bookmarks that were saved with the buggy
// double-encoded URL. Capped at 5 to bound runaway input.
export function recursivelyDecode(s) {
  let cur = s;
  for (let i = 0; i < 5; i++) {
    if (!/%[0-9A-Fa-f]{2}/.test(cur)) break;
    let next;
    try { next = decodeURIComponent(cur); } catch { break; }
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
    const js = recursivelyDecode(new URL(launcherUrl).searchParams.get('js') || '');
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
