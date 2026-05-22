import StorageService from './lib/storage.js';
import EMOJI_DATA from './lib/emoji_data.js';
import MDI_DATA from './lib/mdi_data.js';
import FaviconUtils from './lib/favicon_utils.js';
import {
  isLauncherUrl,
  buildLauncherUrl,
  buildWebhookJs,
  buildWebhookDataUrl,
  isWebhookDataUrl,
  webhookDataTargetUrl,
  webhookDataIconUrl,
  launcherWebhookUrl,
  launcherOriginalUrl,
  healOrphanedLaunchers
} from './lib/launcher.js';

// ── State ──────────────────────────────────────────────────────────────
const State = {
  currentFolderId: '1',
  navigationStack: [{ id: '1', title: 'Bookmark Bar' }],
  customizedMappings: {}, // keyed by URL
  currentView: 'bar',
  selectedBookmark: null,
  selectedIcon: null,
  isSearching: false
};

const MDI_RENDER_CONFIG = { color: '#6366f1', size: 128 };
const CONTENT_SCRIPT_ID = 'bookmark-favicon-override';

// ── DOM Elements ───────────────────────────────────────────────────────
const Elements = {
  bookmarkList: document.getElementById('bookmark-list'),
  searchPicker: document.getElementById('bookmark-search'),
  breadcrumbs: document.getElementById('breadcrumb-list'),
  btnViewBar: document.getElementById('btn-view-bar'),
  btnViewAll: document.getElementById('btn-view-all'),
  btnViewCustomized: document.getElementById('btn-view-customized'),
  storageStatus: document.getElementById('storage-status'),
  pickerModal: document.getElementById('picker-modal'),
  closePicker: document.getElementById('close-picker'),
  targetTitle: document.getElementById('target-title'),
  targetCurrentIcon: document.getElementById('target-current-icon'),
  emojiGrid: document.getElementById('emoji-grid'),
  emojiSearchInput: document.getElementById('emoji-search-input'),
  mdiGrid: document.getElementById('mdi-grid'),
  mdiSearchInput: document.getElementById('mdi-search-input'),
  selectedIconPreview: document.getElementById('selected-icon-preview'),
  confirmBtn: document.getElementById('confirm-btn'),
  btnRestore: document.getElementById('btn-restore'),
  fileInput: document.getElementById('file-input'),
  btnBrowse: document.getElementById('btn-browse'),
  dropZone: document.getElementById('drop-zone'),
  webhookRow: document.getElementById('webhook-row'),
  webhookToggle: document.getElementById('webhook-toggle'),
  applyHint: document.getElementById('apply-hint')
};

const originalFaviconUrl = pageUrl =>
  `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=64`;

// Build a match pattern limited to the URL's origin. Content scripts can only
// be registered for origins the user has explicitly granted us.
function originMatchPattern(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

// Classify bookmarks we can't customize so we can tell the user *why*.
// javascript: and launcher URLs go through a separate code path and are
// not passed to this function.
function unsupportedReason(urlString) {
  let u;
  try { u = new URL(urlString); } catch { return 'This URL is not valid.'; }
  if (u.protocol === 'chrome:' || u.protocol === 'chrome-extension:' || u.protocol === 'about:') {
    return 'Chrome internal pages cannot be customized.';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `URLs with the ${u.protocol} scheme cannot be customized.`;
  }
  return null;
}

const debounce = (fn, delay) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), delay); };
};

// ── Toast helper ───────────────────────────────────────────────────────
function showToast(msg, isError = false) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = `toast show ${isError ? 'error' : 'success'}`;
  // Multi-line messages need longer to read; scale with message length.
  const duration = Math.min(9000, 3500 + msg.length * 25);
  setTimeout(() => toast.className = 'toast', duration);
}

// ── Init ───────────────────────────────────────────────────────────────
async function init() {
  try {
    // Self-heal first: if the extension was uninstalled + reinstalled, any
    // launcher URLs from the old install point at a dead extension ID and
    // their storage mappings are gone. Restore them to their original
    // javascript: form so the bookmarklets work again. Cheap and idempotent.
    // The background service worker also runs this on install/startup; this
    // call covers edge cases (bookmark import, failed service worker, etc.).
    await healOrphanedLaunchers();
    await refreshData();
    // Heal script registration on every open: permissions can be revoked
    // externally (chrome://extensions), storage can be edited out of band.
    await syncContentScripts();
    setupEventListeners();
    renderEmojiGrid();
    renderMdiGrid();
    updateStorageUsage();
    switchView('bar', 'btn-view-bar');
  } catch (err) {
    console.error('Init failed:', err);
  }
}

// ── Data ───────────────────────────────────────────────────────────────
async function refreshData() {
  State.customizedMappings = await StorageService.getMappings();
}

async function renderBookmarks() {
  if (!Elements.bookmarkList) return;
  Elements.bookmarkList.innerHTML = '';
  let items = [];

  try {
    if (State.isSearching) {
      items = await searchBookmarks(Elements.searchPicker.value.toLowerCase());
    } else if (State.currentView === 'customized') {
      items = await getCustomizedBookmarks();
    } else if (State.currentView === 'bar') {
      items = await getBookmarksByFolder('1');
    } else {
      items = await getBookmarksByFolder(State.currentFolderId);
    }
  } catch (err) {
    console.error('Failed to load bookmarks:', err);
    Elements.bookmarkList.innerHTML = '<div class="empty-state">Error loading bookmarks.</div>';
    return;
  }

  if (!items || items.length === 0) {
    Elements.bookmarkList.innerHTML = '<div class="empty-state">No bookmarks found.</div>';
    return;
  }

  items.forEach(item => {
    const mapping = item.url ? State.customizedMappings[item.url] : null;
    const el = document.createElement('div');
    el.className = `bookmark-item ${item.url ? '' : 'folder'} ${mapping ? 'modified' : ''}`;

    let iconUrl;
    if (!item.url) {
      iconUrl = 'icons/folder.png';
    } else if (mapping && mapping.customIcon) {
      iconUrl = mapping.customIcon;
    } else {
      // For data: URL webhooks the icon is embedded in the URL itself, so we
      // can recover it even without a storage mapping (e.g. after a wipe).
      iconUrl = webhookDataIconUrl(item.url) || originalFaviconUrl(item.url);
    }

    el.innerHTML = `
      <div class="favicon-wrapper"><img src="${iconUrl}" onerror="this.src='icons/icon48.png'"></div>
      <div class="bookmark-title" title="${item.title}">${item.title || '(No Title)'}</div>
    `;

    el.onclick = () => item.url ? openPicker(item) : navigateToFolder(item.id, item.title);
    Elements.bookmarkList.appendChild(el);
  });
}

// ── Navigation ─────────────────────────────────────────────────────────
async function navigateToFolder(id, title) {
  const idx = State.navigationStack.findIndex(i => i.id === id);
  if (idx !== -1) {
    State.navigationStack = State.navigationStack.slice(0, idx + 1);
  } else {
    State.navigationStack.push({ id, title });
  }
  State.currentFolderId = id;
  State.isSearching = false;
  Elements.searchPicker.value = '';
  updateBreadcrumbsView();
  await renderBookmarks();
}

function updateBreadcrumbsView() {
  if (!Elements.breadcrumbs) return;
  Elements.breadcrumbs.innerHTML = '';
  State.navigationStack.forEach((item, i) => {
    const li = document.createElement('li');
    li.textContent = item.title;
    li.onclick = () => navigateToFolder(item.id, item.title);
    Elements.breadcrumbs.appendChild(li);
    if (i < State.navigationStack.length - 1) {
      const sep = document.createElement('span');
      sep.textContent = '›';
      sep.className = 'separator';
      Elements.breadcrumbs.appendChild(sep);
    }
  });
}

function resetNavigation(id, title) {
  State.navigationStack = id === '0'
    ? [{ id: '0', title: 'Root' }]
    : [{ id: '0', title: 'Root' }, { id, title }];
  State.currentFolderId = id;
  State.isSearching = false;
  Elements.searchPicker.value = '';
  updateBreadcrumbsView();
  renderBookmarks();
}

// ── Events ─────────────────────────────────────────────────────────────
function setupEventListeners() {
  Elements.searchPicker.oninput = () => {
    State.isSearching = !!Elements.searchPicker.value;
    renderBookmarks();
  };

  Elements.btnViewBar.onclick = () => switchView('bar', 'btn-view-bar');
  Elements.btnViewAll.onclick = () => switchView('all', 'btn-view-all');
  Elements.btnViewCustomized.onclick = () => switchView('customized', 'btn-view-customized');

  Elements.closePicker.onclick = closePicker;
  Elements.confirmBtn.onclick = applyCustomization;
  Elements.btnRestore.onclick = restoreOriginal;
  Elements.webhookToggle.onchange = syncApplyHint;

  const backdrop = document.querySelector('.modal-backdrop');
  if (backdrop) backdrop.onclick = closePicker;

  const debMdi = debounce(q => renderMdiGrid(q), 200);
  const debEmoji = debounce(q => renderEmojiGrid(q), 200);
  Elements.emojiSearchInput.oninput = e => debEmoji(e.target.value);
  Elements.mdiSearchInput.oninput = e => debMdi(e.target.value);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tab-btn, .tab-panel').forEach(el => el.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById(`panel-${btn.dataset.tab}`);
      if (panel) panel.classList.add('active');
    };
  });

  if (Elements.btnBrowse && Elements.fileInput) {
    Elements.btnBrowse.onclick = () => Elements.fileInput.click();
  }
  if (Elements.fileInput) {
    Elements.fileInput.onchange = async (e) => {
      if (e.target.files && e.target.files[0]) {
        try {
          const url = await FaviconUtils.processUploadedImage(e.target.files[0]);
          updateSelectedIconPreview(url);
        } catch (err) {
          showToast('Failed to process image', true);
        }
      }
    };
  }

  if (Elements.dropZone) {
    Elements.dropZone.ondragover = e => { e.preventDefault(); Elements.dropZone.classList.add('dragover'); };
    Elements.dropZone.ondragleave = () => Elements.dropZone.classList.remove('dragover');
    Elements.dropZone.ondrop = async (e) => {
      e.preventDefault();
      Elements.dropZone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        try {
          const url = await FaviconUtils.processUploadedImage(e.dataTransfer.files[0]);
          updateSelectedIconPreview(url);
        } catch (err) {
          showToast('Failed to process image', true);
        }
      }
    };
  }
}

function switchView(view, btnId) {
  State.currentView = view;
  document.querySelectorAll('.view-switcher button').forEach(b => b.classList.remove('active'));
  document.getElementById(btnId)?.classList.add('active');
  if (view === 'bar') resetNavigation('1', 'Bookmark Bar');
  else if (view === 'all') resetNavigation('0', 'Root');
  else renderBookmarks();
}

// ── Picker / Customization ─────────────────────────────────────────────

// Show a different hint depending on what Apply will actually do. Priming is
// what lets Chrome cache the new favicon for the bookmark bar; the hint tells
// the user which side-effect that priming entails so there are no surprises.
const APPLY_HINT_HTTP =
  'On Apply, the page will open briefly in a small window so Chrome can cache the new favicon. ' +
  'The bookmark bar updates once the window closes. Restoring the original icon does the same ' +
  "so Chrome can re-fetch the site's real favicon.";
const APPLY_HINT_WEBHOOK =
  'On Apply, the webhook will be triggered once in a small window so Chrome can cache the new favicon. ' +
  'Future bookmark clicks fire it normally — no page opens then. Unticking and re-applying will revert ' +
  'to the plain URL.';

function syncApplyHint() {
  const bm = State.selectedBookmark;
  if (!bm) { Elements.applyHint.classList.add('hidden'); return; }
  const webhookChecked = Elements.webhookToggle.checked &&
    !Elements.webhookRow.classList.contains('hidden');
  const isJsBookmarklet = bm.url.startsWith('javascript:');
  const isHttp = /^https?:/.test(bm.url);
  const isLauncher = isLauncherUrl(bm.url);

  if (webhookChecked) {
    Elements.applyHint.textContent = APPLY_HINT_WEBHOOK;
    Elements.applyHint.classList.remove('hidden');
    return;
  }
  if (isHttp || isJsBookmarklet || isLauncher) {
    Elements.applyHint.textContent = APPLY_HINT_HTTP;
    Elements.applyHint.classList.remove('hidden');
    return;
  }
  Elements.applyHint.classList.add('hidden');
}

function openPicker(bm) {
  State.selectedBookmark = bm;
  State.selectedIcon = null;

  // Resolve the "display URL" for the user — if this is a webhook-converted
  // bookmark (either a data: URL or legacy launcher URL), we show the underlying
  // https URL rather than the wrapper, and we show the webhook checkbox as checked.
  const webhookUrl = webhookDataTargetUrl(bm.url) ||
                     (isLauncherUrl(bm.url) ? launcherWebhookUrl(bm.url) : null);
  const isHttp = !webhookUrl && /^https?:/.test(bm.url);

  Elements.targetTitle.textContent = bm.title || 'Untitled';

  if (webhookUrl || isHttp) {
    Elements.webhookRow.classList.remove('hidden');
    Elements.webhookToggle.checked = !!webhookUrl;
  } else {
    Elements.webhookRow.classList.add('hidden');
    Elements.webhookToggle.checked = false;
  }

  syncApplyHint();

  const mapping = State.customizedMappings[bm.url];
  const embeddedIcon = webhookDataIconUrl(bm.url);
  if (mapping && mapping.customIcon) {
    Elements.targetCurrentIcon.src = mapping.customIcon;
    Elements.btnRestore.classList.remove('hidden');
    updateSelectedIconPreview(mapping.customIcon);
  } else if (embeddedIcon) {
    Elements.targetCurrentIcon.src = embeddedIcon;
    Elements.btnRestore.classList.remove('hidden');
    updateSelectedIconPreview(embeddedIcon);
  } else {
    Elements.targetCurrentIcon.src = originalFaviconUrl(webhookUrl || bm.url);
    Elements.btnRestore.classList.add('hidden');
    Elements.selectedIconPreview.innerHTML = '<span class="preview-hint">Pick an icon ↑</span>';
    Elements.confirmBtn.disabled = true;
  }

  document.querySelectorAll('.emoji-item.selected').forEach(el => el.classList.remove('selected'));
  Elements.pickerModal.classList.remove('hidden');
}

function closePicker() {
  Elements.pickerModal.classList.add('hidden');
  State.selectedIcon = null;
  State.selectedBookmark = null;
}

/**
 * Save a custom icon for this bookmark's URL.
 *
 * Three paths:
 *
 * - http(s) URLs (default): we don't rewrite the bookmark. Request host
 *   permission for the origin, register a content script that swaps
 *   <link rel="icon"> at document_start. Chrome's favicon cache picks it
 *   up on next visit. If the extension is disabled, the bookmark still
 *   opens the real URL — it just reverts to the site's own favicon.
 *
 * - Webhook URLs (http(s), but user ticked "This is a webhook"): a browser
 *   navigation to these endpoints triggers a server action and receives a
 *   non-HTML response (or a download), so there's no page DOM to inject
 *   into. We convert the bookmark to the bookmarklet path below, wrapping
 *   the URL in a keepalive fetch() so the request fires silently and
 *   survives the launcher tab closing. Unticking restores the original URL.
 *
 * - javascript: URLs (bookmarklets): there's no page to inject into, so we
 *   rewrite the bookmark to chrome-extension://<id>/launcher.html?js=<encoded>
 *   — a real extension page that can carry a favicon and runs the original
 *   code in a sandboxed iframe. The original JS survives verbatim inside
 *   the ?js= param; if the extension is removed, decodeURIComponent on it
 *   recovers the bookmarklet.
 */
async function applyCustomization() {
  if (!State.selectedIcon || !State.selectedBookmark) {
    showToast('Please select an icon first', true);
    return;
  }

  const bm = State.selectedBookmark;

  const isJsBookmarklet = bm.url.startsWith('javascript:');
  const alreadyLauncher = isLauncherUrl(bm.url);
  const alreadyWebhookData = isWebhookDataUrl(bm.url);
  const existingWebhookUrl = webhookDataTargetUrl(bm.url) ||
    (alreadyLauncher ? launcherWebhookUrl(bm.url) : null);
  const wantsWebhook = Elements.webhookToggle.checked &&
    !Elements.webhookRow.classList.contains('hidden');

  // Resolve the underlying https URL for webhook flows (covers both fresh
  // http(s) bookmarks and already-converted webhook bookmarks).
  const baseHttpUrl = existingWebhookUrl || (/^https?:/.test(bm.url) ? bm.url : null);

  let storageKey = bm.url;
  let newBookmarkUrl = null;
  let hostPermissionUrl = null;    // http URL we must hold host permission for
  let oldMappingKey = null;        // stale mapping to drop after a URL migration
  let originToMaybeRevoke = null;  // origin permission to release if no longer needed
  let isWebhookApply = false;      // webhook data: URL path — priming fires the webhook

  if (isJsBookmarklet) {
    storageKey = buildLauncherUrl(bm.url.slice('javascript:'.length));
    newBookmarkUrl = storageKey;
  } else if (wantsWebhook && baseHttpUrl) {
    // http(s) → webhook data: bookmark (or updating the icon on an existing one).
    // Chrome still needs to load the data: URL once so its favicon cache picks
    // up the inlined icon — but loading it runs the fetch in the HTML body,
    // which fires the webhook. That's OK by design: the hint in the picker
    // warns the user, and for most webhooks (lights, gates, toggles) firing
    // once during setup is acceptable.
    storageKey = buildWebhookDataUrl(baseHttpUrl, State.selectedIcon, bm.title || '');
    if (storageKey !== bm.url) newBookmarkUrl = storageKey;
    isWebhookApply = true;
    // If this bookmark was previously customized via the plain-http path,
    // drop that mapping + content script + host permission on conversion.
    if (!existingWebhookUrl && State.customizedMappings[bm.url]) {
      oldMappingKey = bm.url;
      originToMaybeRevoke = bm.url;
    }
    // Each icon change produces a new data: URL; migrate mapping off the old one.
    if (alreadyWebhookData && bm.url !== storageKey) oldMappingKey = bm.url;
    // Upgrading from the legacy launcher webhook to a data: URL — drop the old key.
    if (alreadyLauncher && existingWebhookUrl) oldMappingKey = bm.url;
  } else if (existingWebhookUrl) {
    // User unticked webhook → revert to the original http(s) URL and take
    // the normal content-script path from here.
    newBookmarkUrl = existingWebhookUrl;
    storageKey = existingWebhookUrl;
    hostPermissionUrl = existingWebhookUrl;
    oldMappingKey = bm.url;
  } else if (!alreadyLauncher) {
    const reason = unsupportedReason(bm.url);
    if (reason) { showToast(reason, true); return; }
    hostPermissionUrl = bm.url;
  }

  Elements.confirmBtn.disabled = true;

  try {
    if (hostPermissionUrl) {
      Elements.confirmBtn.textContent = 'Requesting access…';
      const pattern = originMatchPattern(hostPermissionUrl);
      // Must be inside the click handler's user-gesture window.
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) {
        const host = new URL(hostPermissionUrl).hostname;
        showToast(`Permission to modify ${host} is required`, true);
        Elements.confirmBtn.textContent = 'Apply Icon';
        Elements.confirmBtn.disabled = false;
        return;
      }
    }

    Elements.confirmBtn.textContent = 'Saving…';

    if (newBookmarkUrl) {
      await chrome.bookmarks.update(bm.id, { url: newBookmarkUrl });
    }

    if (oldMappingKey && oldMappingKey !== storageKey) {
      await StorageService.removeMapping(oldMappingKey);
    }

    await StorageService.saveMapping(storageKey, {
      customIcon: State.selectedIcon,
      title: bm.title || 'Untitled'
    });

    // syncContentScripts is idempotent and cheap — always run it so
    // registrations follow the current mapping set regardless of flow.
    await syncContentScripts();
    if (originToMaybeRevoke) await maybeRevokeOrigin(originToMaybeRevoke);

    // Pick the right priming surface:
    //  - launcher URLs (our own extension page): cheap background tab
    //  - data: webhook URLs: visible popup window — loading it runs the inline
    //    fetch, which fires the user's webhook once (warned in the picker hint)
    //  - http(s) URLs: visible popup window so our content script's favicon
    //    swap sticks in Chrome's cache reliably
    const isLauncher = storageKey.startsWith('chrome-extension://');
    Elements.confirmBtn.textContent = isLauncher
      ? 'Priming…'
      : (isWebhookApply ? 'Triggering webhook to cache icon…' : 'Loading page to refresh favicon…');
    await primeFaviconCache(storageKey, { useWindow: !isLauncher });

    await refreshData();
    await renderBookmarks();
    updateStorageUsage();

    showToast(isWebhookApply
      ? `Icon set for "${bm.title}". Your webhook was triggered once so Chrome could cache the new favicon — future clicks will fire it as usual.`
      : `Icon set for "${bm.title}" — the bookmark-bar icon refreshes after Chrome caches the new favicon.`);
    closePicker();
  } catch (err) {
    console.error('Failed to apply:', err);
    showToast('Failed to save: ' + err.message, true);
    Elements.confirmBtn.textContent = 'Apply Icon';
    Elements.confirmBtn.disabled = false;
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
// executeScript closes that race. content_script.js is idempotent, so
// double-injection (registered + direct) is harmless.
async function primeFaviconCache(url, { useWindow = false } = {}) {
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
        // Inject as early as we can — first 'loading' or URL-set event.
        if (!injected && (info.status === 'loading' || info.url)) tryInject();
        if (info.status === 'complete') {
          // Last-chance injection if no earlier event fired (rare).
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
      // Hard cap — slow/hanging pages shouldn't lock up the UI.
      setTimeout(finish, useWindow ? 10000 : 6000);
    });
    await closer();
  } finally {
    await chrome.storage.session.remove('primingUrl');
  }
}

async function restoreOriginal() {
  if (!State.selectedBookmark) return;
  const bm = State.selectedBookmark;

  try {
    await StorageService.removeMapping(bm.url);

    // Track the URL to prime after restore so Chrome writes the site's real
    // favicon back into its cache — otherwise the bookmark bar would keep
    // showing our custom icon until the user manually visits the page.
    let primeUrl = null;
    const dataWebhookTarget = webhookDataTargetUrl(bm.url);
    if (dataWebhookTarget) {
      // data: URL webhook → revert to the original https target.
      await chrome.bookmarks.update(bm.id, { url: dataWebhookTarget });
      primeUrl = dataWebhookTarget;
    } else if (isLauncherUrl(bm.url)) {
      // Restore the bookmark to its pre-customization form: webhook launchers
      // go back to the original https URL; regular bookmarklet launchers go
      // back to javascript:<source>. launcherOriginalUrl() picks the right one.
      const originalUrl = launcherOriginalUrl(bm.url);
      await chrome.bookmarks.update(bm.id, { url: originalUrl });
      if (/^https?:/.test(originalUrl)) primeUrl = originalUrl;
    } else {
      await syncContentScripts();
      await maybeRevokeOrigin(bm.url);
      if (/^https?:/.test(bm.url)) primeUrl = bm.url;
    }

    if (primeUrl) {
      Elements.btnRestore.textContent = 'Loading page to refresh favicon…';
      await primeFaviconCache(primeUrl, { useWindow: true });
      Elements.btnRestore.textContent = 'Restore Original';
    }

    await refreshData();
    await renderBookmarks();
    updateStorageUsage();
    showToast(primeUrl
      ? `Restored original icon for "${bm.title}" — bookmark bar updates once Chrome re-caches the site's favicon`
      : `Restored original icon for "${bm.title}"`);
    closePicker();
  } catch (err) {
    console.error('Failed to restore:', err);
    showToast('Failed to restore: ' + err.message, true);
  }
}

// Revoke the origin permission if no other customized URL still needs it.
// Best-effort: chrome.permissions.remove can reject on some origin patterns
// and we don't want that to surface as a user-facing error.
async function maybeRevokeOrigin(url) {
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

// Keep the single registered content script in sync with storage + permissions.
// Running this on popup open heals the registration against out-of-band edits.
async function syncContentScripts() {
  const mappings = await StorageService.getMappings();

  // Collect unique origin patterns we actually hold permission for.
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

// ── Icon Grids ─────────────────────────────────────────────────────────
function renderEmojiGrid(filter = '') {
  Elements.emojiGrid.innerHTML = '';
  const query = filter.toLowerCase();
  const filtered = EMOJI_DATA.filter(e => {
    const searchable = e.tags || e.name || '';
    return searchable.toLowerCase().includes(query);
  }).slice(0, 200);

  filtered.forEach(e => {
    const div = document.createElement('div');
    div.className = 'emoji-item';
    div.textContent = e.char;
    div.title = e.tags || e.name || '';
    div.onclick = () => {
      document.querySelectorAll('.emoji-item.selected').forEach(el => el.classList.remove('selected'));
      div.classList.add('selected');
      selectEmoji(e.char);
    };
    Elements.emojiGrid.appendChild(div);
  });
}

function renderMdiGrid(filter = '') {
  Elements.mdiGrid.innerHTML = '';
  const query = filter.toLowerCase();
  const filtered = MDI_DATA.filter(i => {
    const name = i.n || '';
    return name.toLowerCase().includes(query);
  }).slice(0, 300);

  filtered.forEach(i => {
    const div = document.createElement('div');
    div.className = 'emoji-item';
    div.innerHTML = `<svg viewBox="0 0 24 24" style="width:24px;height:24px;fill:currentColor"><path d="${i.p}" /></svg>`;
    div.title = i.n || '';
    div.onclick = () => {
      document.querySelectorAll('.emoji-item.selected').forEach(el => el.classList.remove('selected'));
      div.classList.add('selected');
      selectMdiIcon(i);
    };
    Elements.mdiGrid.appendChild(div);
  });
}

function updateSelectedIconPreview(icon) {
  Elements.selectedIconPreview.innerHTML = `<img src="${icon}" style="width:100%;height:100%;object-fit:contain;">`;
  Elements.confirmBtn.disabled = false;
  Elements.confirmBtn.textContent = 'Apply Icon';
  State.selectedIcon = icon;
}

async function selectEmoji(char) {
  try {
    const url = await FaviconUtils.emojiToDataUrl(char);
    updateSelectedIconPreview(url);
  } catch (err) {
    console.error('Failed to render emoji:', err);
    showToast('Failed to render emoji', true);
  }
}

async function selectMdiIcon(item) {
  try {
    const url = await FaviconUtils.svgToDataUrl(item.p, MDI_RENDER_CONFIG.color);
    updateSelectedIconPreview(url);
  } catch (err) {
    console.error('Failed to render MDI icon:', err);
    showToast('Failed to render icon', true);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────
async function searchBookmarks(q) {
  return new Promise(r => chrome.bookmarks.search(q, r));
}

async function getBookmarksByFolder(id) {
  return new Promise(r => chrome.bookmarks.getChildren(id, r));
}

// Walk the full bookmark tree and return nodes whose URL has a customization.
async function getCustomizedBookmarks() {
  const urls = new Set(Object.keys(State.customizedMappings));
  if (urls.size === 0) return [];
  const tree = await chrome.bookmarks.getTree();
  const results = [];
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.url && urls.has(n.url)) results.push(n);
      if (n.children) walk(n.children);
    }
  })(tree);
  return results;
}

async function updateStorageUsage() {
  try {
    const bytes = await StorageService.getUsage();
    Elements.storageStatus.textContent = `Storage: ${Math.round(bytes / 1024)} KB / 5120 KB`;
  } catch (err) {
    console.error('Storage usage error:', err);
  }
}

init();
