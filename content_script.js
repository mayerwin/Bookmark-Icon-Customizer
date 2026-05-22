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

  const currentUrl = window.location.href;
  const { bookmark_icons: mappings = {} } = await chrome.storage.local.get('bookmark_icons');
  const entry = mappings[currentUrl];
  if (!entry || !entry.customIcon) return;

  const customHref = entry.customIcon;
  const ICON_SELECTOR =
    'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"], link[rel="mask-icon"]';
  let myLink = null;

  function applyIcon() {
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
})();
