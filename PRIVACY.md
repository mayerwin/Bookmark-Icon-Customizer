# Privacy Policy — Bookmark Icon Customizer

**Last updated:** 2026-04-18

Bookmark Icon Customizer is designed with privacy as a first principle. This policy explains exactly what the extension does — and does not — do with your data.

## What we store

The extension stores your custom icon mappings locally in your browser via `chrome.storage.local`. Each mapping pairs a bookmark URL with an icon (an emoji, an MDI glyph, or an image you uploaded).

This data never leaves your browser. It is not synced to any server we operate.

## What we do not collect

- We do **not** collect, transmit, or sell any personal data.
- We do **not** track your browsing activity.
- We do **not** use analytics, telemetry, or third-party tracking scripts.
- We do **not** have servers that receive your bookmarks or icons.

## Network requests

The extension only makes network requests in two explicit cases, both driven by URLs you configure:

1. **Bookmarks you click.** When you activate a customized bookmark, your browser navigates to the original URL (for normal bookmarks) or executes your bookmarklet code (for `javascript:` bookmarks) — exactly as it would without the extension.
2. **Webhooks you tick.** If you check the "This is a webhook" option on a bookmark, the extension fires a `fetch` to that URL when the bookmark is clicked. The request is sent only to the webhook URL you configured, and only when you click the bookmark.

No other network requests are made.

## Permissions

- `bookmarks` — read and update your bookmarks so we can attach custom icons.
- `storage` — persist your icon mappings locally.
- `favicon` — read the default favicon of a bookmark so we can show the "restore original" preview.
- `scripting` + optional `<all_urls>` host access — only requested if you opt into priming (opening a bookmark's target once so Chrome caches the favicon).

## Uninstalling

Removing the extension deletes all locally stored mappings. Your bookmarks are restored to ordinary URLs (customized `javascript:` bookmarks self-heal back to their original source on next extension load).

## Contact

Issues and questions: <https://github.com/mayerwin/Bookmark-Icon-Customizer/issues>
