// bg-sync.js — mirrors the user's settings between this device and Chrome sync.
//
// A classic script loaded by background.js via importScripts (shared worker
// scope). The rest of the extension only ever reads/writes chrome.storage.local;
// this bridge keeps ARPSettingsSync.SYNC_KEYS in step with chrome.storage.sync:
//   • a local change is pushed (minus device-only webhook fields);
//   • a change from another device is sanitized like an import, merged with
//     this device's webhook fields, and written locally;
//   • on install / browser start, sync wins if it has a value, otherwise this
//     device seeds it (so the first device to sync becomes the shared copy).
// Writes are skipped when nothing would change, which is also what stops a
// push → pull → push echo. Requires the pinned manifest `key`: Chrome keys
// sync storage by extension ID, and unpacked copies only share one with it.

const syncBridgeMutex = ARPSerialize.createMutex();

function syncArea() {
  return chrome.storage && chrome.storage.sync ? chrome.storage.sync : null;
}

async function pushSettingToSync(key) {
  const area = syncArea();
  if (!area) return;
  return syncBridgeMutex(async () => {
    const local = (await chrome.storage.local.get(key))[key];
    if (local === undefined) return; // nothing here to share (deletes don't propagate)
    const value = ARPSettingsSync.toSync(key, local);
    const current = (await area.get(key))[key];
    if (ARPSettingsSync.sameValue(value, current)) return;
    if (!ARPSettingsSync.fitsSync(key, value)) {
      console.warn('Setting too large for Chrome sync; kept on this device only:', key);
      return;
    }
    try { await area.set({ [key]: value }); }
    catch (e) { console.warn('Chrome sync write failed; kept on this device only:', key, e); }
  });
}

async function pullSettingFromSync(key) {
  const area = syncArea();
  if (!area) return;
  return syncBridgeMutex(async () => {
    const remote = (await area.get(key))[key];
    if (remote === undefined) return;
    // Another device's value crosses a trust boundary: same sanitizer as an import.
    const clean = ARPValidators.sanitizeImportedSettings({ [key]: remote }).value;
    if (!clean || !(key in clean)) return;
    const local = (await chrome.storage.local.get(key))[key];
    const merged = ARPSettingsSync.fromSync(key, clean[key], local);
    if (ARPSettingsSync.sameValue(merged, local)) return;
    await chrome.storage.local.set({ [key]: merged });
  });
}

// Install / browser start: sync wins where it has a value; otherwise seed it.
async function reconcileSettingsSync() {
  const area = syncArea();
  if (!area) return;
  let remote = {};
  try { remote = await area.get([...ARPSettingsSync.SYNC_KEYS]); } catch (e) { return; }
  for (const key of ARPSettingsSync.SYNC_KEYS) {
    if (remote[key] !== undefined) await pullSettingFromSync(key);
    else await pushSettingToSync(key);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' && area !== 'sync') return;
  for (const key of ARPSettingsSync.SYNC_KEYS) {
    if (!(key in changes)) continue;
    if (area === 'local') pushSettingToSync(key);
    else pullSettingFromSync(key);
  }
});
chrome.runtime.onInstalled.addListener(() => { reconcileSettingsSync(); });
chrome.runtime.onStartup.addListener(() => { reconcileSettingsSync(); });
