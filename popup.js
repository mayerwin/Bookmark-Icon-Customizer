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
  buildPageInjectJs,
  launcherPageInjectCode,
  buildBookmarkletDataUrl,
  isBookmarkletDataUrl,
  bookmarkletDataUrlMode,
  bookmarkletDataUrlSource,
  bookmarkletDataUrlIconUrl,
  recursivelyDecode,
  healOrphanedLaunchers
} from './lib/launcher.js';
import {
  originMatchPattern,
  syncContentScripts,
  maybeRevokeOrigin,
  primeFaviconCache,
  completePendingApply
} from './lib/apply.js';

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
  pageInjectRow: document.getElementById('page-inject-row'),
  pageInjectToggle: document.getElementById('page-inject-toggle'),
  applyHint: document.getElementById('apply-hint'),
  appVersion: document.getElementById('app-version')
};

const originalFaviconUrl = pageUrl =>
  `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=64`;

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
  // Stamp the real extension version into the footer (single source of truth:
  // manifest.json) so it can never drift from the shipped build. Set before
  // the try block so a later init failure still shows the correct version.
  if (Elements.appVersion) Elements.appVersion.textContent = 'v' + chrome.runtime.getManifest().version;
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
      // For data: URL webhooks / bookmarklets the icon is embedded in the
      // URL itself, so we can recover it even without a storage mapping
      // (e.g. after a wipe).
      iconUrl = webhookDataIconUrl(item.url) ||
                bookmarkletDataUrlIconUrl(item.url) ||
                originalFaviconUrl(item.url);
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
  Elements.pageInjectToggle.onchange = syncApplyHint;

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
const APPLY_HINT_PAGE_INJECT =
  'On Apply, the extension will ask Chrome for permission to access all sites — needed so your ' +
  'bookmarklet can run on whatever page you click it from. After clicking the bookmark the tab will ' +
  'briefly navigate away and back; on most pages Chrome restores form values and JS state from cache, ' +
  'but pages with an unsaved-changes warning (e.g. rich editors) will reload — keep those as raw ' +
  'javascript: URLs (no custom icon) if that matters.';
const APPLY_HINT_LAUNCHER_SANDBOX =
  'On Apply, a small tab opens briefly in the background to cache the new favicon. Your bookmarklet ' +
  'will run inside that tab’s sandbox iframe when you click it — fine for fire-and-forget JS that ' +
  'doesn’t read or modify the page. For bookmarklets that touch the current page (add buttons, ' +
  'edit content, etc.), tick "Run on the current page" above.';

function syncApplyHint() {
  const bm = State.selectedBookmark;
  if (!bm) { Elements.applyHint.classList.add('hidden'); return; }
  const webhookChecked = Elements.webhookToggle.checked &&
    !Elements.webhookRow.classList.contains('hidden');
  const pageInjectChecked = Elements.pageInjectToggle.checked &&
    !Elements.pageInjectRow.classList.contains('hidden');
  const pageInjectVisible = !Elements.pageInjectRow.classList.contains('hidden');
  const isJsBookmarklet = bm.url.startsWith('javascript:');
  const isHttp = /^https?:/.test(bm.url);
  const isLauncher = isLauncherUrl(bm.url);

  if (webhookChecked) {
    Elements.applyHint.textContent = APPLY_HINT_WEBHOOK;
    Elements.applyHint.classList.remove('hidden');
    return;
  }
  if (pageInjectChecked) {
    Elements.applyHint.textContent = APPLY_HINT_PAGE_INJECT;
    Elements.applyHint.classList.remove('hidden');
    return;
  }
  if (pageInjectVisible) {
    // Page-inject row visible but unchecked → sandbox-mode hint that
    // explains the trade-off so the user knows when to enable it.
    Elements.applyHint.textContent = APPLY_HINT_LAUNCHER_SANDBOX;
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
  const isJsBookmarklet = bm.url.startsWith('javascript:');
  // A non-webhook launcher is a legacy chrome-extension://launcher.html
  // bookmark from an older build; re-applying migrates it to the data: URL
  // format. The data: URL form is the current canonical bookmarklet bookmark.
  const isPlainLauncher = !webhookUrl && isLauncherUrl(bm.url);
  const isBookmarkletData = isBookmarkletDataUrl(bm.url);
  const showPageInjectToggle = isJsBookmarklet || isPlainLauncher || isBookmarkletData;

  // Pre-check state for the page-inject toggle:
  let pageInjectDefault = false;
  if (isJsBookmarklet) {
    // Fresh conversion — most bookmarklets need page DOM access, so opt in
    // by default; the user can untick to use sandbox mode (no permission ask).
    pageInjectDefault = true;
  } else if (isBookmarkletData) {
    pageInjectDefault = bookmarkletDataUrlMode(bm.url) === 'page-inject';
  } else if (isPlainLauncher) {
    pageInjectDefault = launcherPageInjectCode(bm.url) !== null;
  }

  Elements.targetTitle.textContent = bm.title || 'Untitled';

  if (webhookUrl || isHttp) {
    Elements.webhookRow.classList.remove('hidden');
    Elements.webhookToggle.checked = !!webhookUrl;
  } else {
    Elements.webhookRow.classList.add('hidden');
    Elements.webhookToggle.checked = false;
  }

  if (showPageInjectToggle) {
    Elements.pageInjectRow.classList.remove('hidden');
    Elements.pageInjectToggle.checked = pageInjectDefault;
  } else {
    Elements.pageInjectRow.classList.add('hidden');
    Elements.pageInjectToggle.checked = false;
  }

  syncApplyHint();

  const mapping = State.customizedMappings[bm.url];
  const embeddedIcon = webhookDataIconUrl(bm.url) || bookmarkletDataUrlIconUrl(bm.url);
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
 * - javascript: URLs (bookmarklets): there's no DOM-bearing "current page"
 *   to attach a favicon to, so we rewrite the bookmark to
 *   chrome-extension://<id>/launcher.html?js=<encoded> — a real extension
 *   page that can carry a favicon. From there, two sub-modes (gated by the
 *   "Run on the current page" toggle in the picker):
 *
 *     a) Page-inject (toggle ON, the common case): the source is prefixed
 *        with /*BIC-PAGE-INJECT*​/ before encoding. When the user clicks
 *        the bookmark, the launcher hands the source off to background.js,
 *        which chrome.scripting.executeScript's it into the user's prior
 *        page in MAIN world — same execution surface as a native
 *        javascript: URL. Requires <all_urls> host permission (one prompt).
 *
 *     b) Sandbox (toggle OFF): the source runs in launcher.html's sandbox
 *        iframe. No DOM access to the user's page — usable only for
 *        fire-and-forget JS (open a URL, ping a server) that doesn't read
 *        or modify the page. No extra permission.
 *
 *   In both sub-modes the original JS is preserved verbatim inside the
 *   ?js= param; decoding it (and stripping the marker if present)
 *   recovers the bookmarklet even after the extension is removed.
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
  const wantsPageInject = Elements.pageInjectToggle.checked &&
    !Elements.pageInjectRow.classList.contains('hidden');

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
    // Fresh javascript: bookmark → data:text/html with inlined favicon.
    // The launcher URL approach (chrome-extension://launcher.html) can't
    // carry a custom favicon — Chrome substitutes the manifest icon on
    // any chrome-extension:// bookmark, ignoring the page's <link rel="icon">.
    // data: URLs let us inline the favicon, which Chrome does honor.
    const rawJs = recursivelyDecode(bm.url.slice('javascript:'.length));
    storageKey = buildBookmarkletDataUrl(rawJs, State.selectedIcon, bm.title || '', { pageInject: wantsPageInject });
    newBookmarkUrl = storageKey;
    if (wantsPageInject) hostPermissionUrl = '<all_urls>';
  } else if (isBookmarkletDataUrl(bm.url)) {
    // Existing data: URL bookmarklet — rebuild with the new icon and/or
    // mode. Each rebuild produces a fresh URL (the icon is inlined), so
    // we migrate the mapping off the old key.
    const rawJs = bookmarkletDataUrlSource(bm.url);
    if (rawJs === null) { showToast('Could not read bookmarklet source', true); return; }
    const newStorageKey = buildBookmarkletDataUrl(rawJs, State.selectedIcon, bm.title || '', { pageInject: wantsPageInject });
    if (newStorageKey !== bm.url) {
      storageKey = newStorageKey;
      newBookmarkUrl = newStorageKey;
      oldMappingKey = bm.url;
    }
    if (wantsPageInject) hostPermissionUrl = '<all_urls>';
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
  } else if (alreadyLauncher) {
    // Existing non-webhook chrome-extension://launcher.html bookmark from
    // an older build. Always migrate to the data:text/html format on
    // re-apply so the favicon actually shows (Chrome substitutes the
    // manifest icon on chrome-extension:// URLs).
    const existingPageInjectCode = launcherPageInjectCode(bm.url);
    let rawJs;
    if (existingPageInjectCode !== null) {
      rawJs = existingPageInjectCode;
    } else {
      try {
        rawJs = recursivelyDecode(new URL(bm.url).searchParams.get('js') || '');
      } catch { rawJs = ''; }
    }
    const newStorageKey = buildBookmarkletDataUrl(rawJs, State.selectedIcon, bm.title || '', { pageInject: wantsPageInject });
    storageKey = newStorageKey;
    newBookmarkUrl = newStorageKey;
    oldMappingKey = bm.url;
    if (wantsPageInject) hostPermissionUrl = '<all_urls>';
  } else {
    const reason = unsupportedReason(bm.url);
    if (reason) { showToast(reason, true); return; }
    hostPermissionUrl = bm.url;
  }

  Elements.confirmBtn.disabled = true;

  // Pick the right priming surface:
  //  - launcher URLs (our own extension page): cheap background tab
  //  - data: webhook URLs: visible popup window — loading it runs the inline
  //    fetch, which fires the user's webhook once (warned in the picker hint)
  //  - http(s) URLs: visible popup window so our content script's favicon
  //    swap sticks in Chrome's cache reliably
  const isLauncher = storageKey.startsWith('chrome-extension://');

  // Resolve the match pattern for the permission request. '<all_urls>'
  // bypasses per-host normalization — it's the literal match pattern Chrome
  // expects when a feature needs to inject into arbitrary pages (page-inject
  // bookmarklet mode). Page-inject also needs the optional `webNavigation`
  // API permission so background.js can detect the data: URL navigation
  // — chrome.tabs.onUpdated scrubs data: URLs and can't see them.
  let permissionPattern = null;
  if (hostPermissionUrl === '<all_urls>') permissionPattern = '<all_urls>';
  else if (hostPermissionUrl) permissionPattern = originMatchPattern(hostPermissionUrl);
  const permissionNames = wantsPageInject ? ['webNavigation'] : null;

  const pendingApply = {
    bookmarkId: bm.id,
    newBookmarkUrl,
    oldMappingKey,
    storageKey,
    customIcon: State.selectedIcon,
    title: bm.title || 'Untitled',
    originToMaybeRevoke,
    useWindow: !isLauncher,
    permissionPattern,
    permissionNames
  };

  try {
    if (hostPermissionUrl || permissionNames) {
      Elements.confirmBtn.textContent = 'Requesting access…';
      // Stash the pending apply so background.js's permissions.onAdded
      // listener can finish the work if this popup gets closed by the
      // permission prompt — a known Windows quirk where the modal steals
      // focus from the extension action popup. Without this hand-off the
      // popup's await never resolves and nothing past the request runs,
      // so the user has to apply twice for the icon to take effect.
      await chrome.storage.session.set({ pendingApply });
      // Must be inside the click handler's user-gesture window. Bundle
      // host + API permissions into a single prompt so the user sees one
      // dialog (Chrome merges adjacent permission asks into a combined
      // "wants to: access all sites + read your browsing history" view).
      const req = {};
      if (permissionPattern) req.origins = [permissionPattern];
      if (permissionNames) req.permissions = permissionNames;
      const granted = await chrome.permissions.request(req);
      if (!granted) {
        await chrome.storage.session.remove('pendingApply');
        if (hostPermissionUrl === '<all_urls>') {
          showToast(
            'Permission to access all sites + read browser navigation is required to run this ' +
            'bookmarklet on the page. Untick "Run on the current page" to use sandbox mode ' +
            '(no extra permission), or apply again and accept the prompt.',
            true
          );
        } else if (hostPermissionUrl) {
          const host = new URL(hostPermissionUrl).hostname;
          showToast(`Permission to modify ${host} is required`, true);
        } else {
          showToast('Permission required to run the bookmarklet on the page.', true);
        }
        Elements.confirmBtn.textContent = 'Apply Icon';
        Elements.confirmBtn.disabled = false;
        return;
      }
      // We survived the prompt. Claim the work so background doesn't
      // double-fire; if it already fired (unlikely — we have the 750ms
      // grace window in background.js), the rest is idempotent.
      await chrome.storage.session.remove('pendingApply');
    }

    Elements.confirmBtn.textContent = isLauncher
      ? 'Priming…'
      : (isWebhookApply ? 'Triggering webhook to cache icon…' : 'Loading page to refresh favicon…');
    await completePendingApply(pendingApply);

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
    const dataBookmarkletSource = bookmarkletDataUrlSource(bm.url);
    if (dataWebhookTarget) {
      // data: URL webhook → revert to the original https target.
      await chrome.bookmarks.update(bm.id, { url: dataWebhookTarget });
      primeUrl = dataWebhookTarget;
    } else if (dataBookmarkletSource !== null) {
      // data: URL bookmarklet → revert to the original javascript: URL.
      await chrome.bookmarks.update(bm.id, { url: `javascript:${dataBookmarkletSource}` });
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
