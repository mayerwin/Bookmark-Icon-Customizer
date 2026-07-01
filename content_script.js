(async function () {
  // Single-instance guard. During the apply flow, popup.js injects this
  // script into the priming tab via chrome.scripting.executeScript while
  // the chrome.scripting-registered injection may also fire — two
  // instances each holding their own `myLink` would treat each other's
  // <link rel="icon"> as a competitor in the MutationObserver callback,
  // ripping each other's tag out of <head> in a tight loop. Chrome's
  // favicon cache then can't settle and the bookmark bar icon stays stale.
  if (window.__BIC_FAVICON_OVERRIDE_INSTALLED__) return;
  window.__BIC_FAVICON_OVERRIDE_INSTALLED__ = true;

  const { bookmark_icons: mappings = {} } = await chrome.storage.local.get('bookmark_icons');

  // Resolve the custom icon for a page URL.
  //
  // 1. Exact full-URL match — the original behaviour, and the key Chrome's
  //    favicon cache is primed against.
  // 2. Fallback "params-subset" match: a stored key also matches when it
  //    shares the live URL's origin + pathname AND every query parameter in
  //    the stored key is present with the same value in the live URL (the
  //    live URL may carry extra params). The most specific stored key — the
  //    one matching the most params — wins, so two bookmarks that differ only
  //    by query string keep distinct icons.
  //
  // Why the fallback exists: some sites don't load the URL you bookmarked.
  // NetSuite, for instance, server-redirects list/saved-search URLs like
  // …/savedsearchlist.nl?searchtype=SavedSearch&searchid=6484 to the same URL
  // plus a volatile &whence=… token (and rewrites the URL on in-page nav).
  // The content script then runs at document_start on the *redirected* URL,
  // an exact-only match misses, and Chrome caches the site's own favicon
  // against the bookmark — so the custom icon silently "goes missing". A
  // bare-path bookmark (no query) has nothing to append and never drifts,
  // which is why only the query-string bookmarks were affected. Subset
  // matching recognises the redirected URL and re-applies our icon.
  function resolveIcon(href) {
    const exact = mappings[href];
    if (exact && exact.customIcon) return exact.customIcon;
    let live;
    try { live = new URL(href); } catch { return null; }
    let best = null;
    let bestScore = -1;
    for (const key of Object.keys(mappings)) {
      const entry = mappings[key];
      if (!entry || !entry.customIcon) continue;
      let k;
      try { k = new URL(key); } catch { continue; }
      if (k.origin !== live.origin || k.pathname !== live.pathname) continue;
      let ok = true;
      let score = 0;
      for (const [name, value] of k.searchParams) {
        if (live.searchParams.get(name) !== value) { ok = false; break; }
        score++;
      }
      if (ok && score > bestScore) { best = entry.customIcon; bestScore = score; }
    }
    return best;
  }

  const ICON_SELECTOR =
    'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"], link[rel="mask-icon"]';
  let myLink = null;
  let customHref = resolveIcon(window.location.href);
  if (!customHref) return;

  function applyIcon() {
    if (!customHref) return;
    // Strip every competing icon declaration (keep only ours).
    document.querySelectorAll(ICON_SELECTOR).forEach(el => {
      if (el !== myLink) el.remove();
    });
    if (!myLink || !myLink.isConnected) {
      myLink = document.createElement('link');
      myLink.rel = 'icon';
      myLink.type = 'image/png';
      myLink.href = customHref;
      (document.head || document.documentElement).appendChild(myLink);
    }
  }

  applyIcon();

  // Re-apply if the page (or a framework) mutates <head> and re-declares an icon.
  const observer = new MutationObserver(mutations => {
    if (!customHref) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1 && node.matches && node.matches(ICON_SELECTOR) && node !== myLink) {
          applyIcon();
          return;
        }
      }
      for (const node of m.removedNodes) {
        if (node === myLink) {
          myLink = null;
          applyIcon();
          return;
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Single-page-app navigations (history.pushState/replaceState, Back/Forward)
  // change the URL without reloading the document, so re-resolve against the
  // new URL — it may map to a different icon, the same one, or none. Without
  // this, an in-page nav to a customized URL variant wouldn't pick up its icon.
  function onUrlChange() {
    const next = resolveIcon(window.location.href);
    if (next === customHref) return;
    customHref = next;
    if (myLink) { myLink.remove(); myLink = null; }
    if (customHref) applyIcon();
  }
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function () {
      const result = original.apply(this, arguments);
      onUrlChange();
      return result;
    };
  }
  window.addEventListener('popstate', onUrlChange);
})();
