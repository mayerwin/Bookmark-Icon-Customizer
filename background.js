/**
 * Service worker. Two responsibilities:
 *
 * 1. Heal launcher URLs on install/update/startup so bookmarklet bookmarks
 *    work again after the extension is reinstalled (which mints a fresh
 *    extension ID and invalidates the chrome-extension://<old-id>/launcher
 *    URLs the user had saved).
 *
 * 2. Complete the apply flow on behalf of the popup when the host-permission
 *    prompt closes the popup mid-await. The popup stashes a `pendingApply`
 *    record in chrome.storage.session before requesting permission; if it
 *    survives the prompt it removes the record and finishes the work
 *    itself, otherwise this listener picks it up and runs the same shared
 *    completePendingApply() pipeline so the user gets the icon on the
 *    first click instead of having to repeat the whole apply.
 */
import { healOrphanedLaunchers } from './lib/launcher.js';
import { completePendingApply } from './lib/apply.js';

async function runHeal(trigger) {
  try {
    const count = await healOrphanedLaunchers();
    if (count > 0) {
      console.info(`[Bookmark Icon Customizer] ${trigger}: restored ${count} bookmarklet(s) whose custom icons were lost.`);
    }
  } catch (e) {
    console.error(`[Bookmark Icon Customizer] heal failed (${trigger}):`, e);
  }
}

chrome.runtime.onInstalled.addListener(() => runHeal('onInstalled'));
chrome.runtime.onStartup.addListener(() => runHeal('onStartup'));

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
    console.info('[Bookmark Icon Customizer] Apply completed in background after popup closed during permission grant.');
  } catch (e) {
    console.error('[Bookmark Icon Customizer] Background apply failed:', e);
  }
});
