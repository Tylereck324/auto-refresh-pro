'use strict';

// A small deterministic Chrome/service-worker facade for exercising the real
// background.js message handler without launching a browser. The harness is
// intentionally narrow: it implements the APIs used by the lifecycle and
// settings-update paths and fails loudly when a test reaches an unexpected API.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function event() {
  const listeners = [];
  return {
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    listeners,
  };
}

function createHarness(options = {}) {
  const repoRoot = path.resolve(__dirname, '..');
  const storage = { ...(options.storage || {}) };
  const tab = { id: 7, url: 'https://example.test/list', pendingUrl: '', status: 'complete', title: 'Example' };
  const calls = [];
  const tabsOnUpdated = event();
  const gates = {
    tabGetCalled: deferred(),
    tabGetRelease: null,
  };
  let gateFirstTabGet = !!options.gateFirstTabGet;
  let tabGetCallCount = 0;

  const runtime = {
    id: 'extension-test-id',
    lastError: null,
    getURL: (p = '') => 'chrome-extension://extension-test-id/' + String(p).replace(/^\//, ''),
    onMessage: event(),
    onInstalled: event(),
    onStartup: event(),
    async sendMessage(...args) {
      calls.push({ api: 'runtime.sendMessage', args });
      const callback = args[args.length - 1];
      if (typeof callback === 'function') callback({ ok: true });
      return { ok: true };
    },
  };
  // Local and session areas are separate stores; set() calls are recorded as
  // 'storage.set' (local, kept for existing assertions) and 'session.set'.
  function makeArea(store, setApi, failures) {
    return {
      async get(keys) {
        if (keys == null) return { ...store };
        const names = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of names) if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key];
        return out;
      },
      async set(values) {
        if (failures.set) throw new Error(setApi + ' failed');
        // Clone like Chrome does, so later in-memory mutation can't leak in.
        Object.assign(store, JSON.parse(JSON.stringify(values)));
        calls.push({ api: setApi, values });
      },
      async remove(keys) {
        for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key];
        calls.push({ api: setApi.replace('.set', '.remove'), keys });
      },
    };
  }
  const sessionStorage = { ...(options.session || {}) };
  const failures = { local: {}, session: {} };
  const storageArea = makeArea(storage, 'storage.set', failures.local);
  const sessionArea = makeArea(sessionStorage, 'session.set', failures.session);
  const syncStorage = { ...(options.sync || {}) };
  failures.sync = {};
  const syncArea = makeArea(syncStorage, 'sync.set', failures.sync);

  const chrome = {
    runtime,
    storage: { local: storageArea, session: sessionArea, sync: syncArea, onChanged: event() },
    tabs: {
      onRemoved: event(),
      onUpdated: tabsOnUpdated,
      async get(tabId) {
        tabGetCallCount++;
        calls.push({ api: 'tabs.get', tabId });
        if (tabGetCallCount === 1) {
          gates.tabGetCalled.resolve();
          if (gateFirstTabGet) {
            gates.tabGetRelease = deferred();
            await gates.tabGetRelease.promise;
          }
        }
        return { ...tab, id: Number(tabId) || tab.id };
      },
      sendMessage(tabId, message, callback) {
        calls.push({ api: 'tabs.sendMessage', tabId, message });
        if (callback) callback({ ok: true });
        return Promise.resolve({ ok: true });
      },
      async reload(tabId, reloadProperties) {
        calls.push({ api: 'tabs.reload', tabId, reloadProperties });
        tab.status = 'loading';
        for (const listener of [...tabsOnUpdated.listeners]) {
          await listener(tabId, { status: 'loading' }, { ...tab, id: tabId });
        }
        if (typeof options.onReload === 'function') {
          await options.onReload({ tabId, reloadProperties, tab, calls });
        }
        if (options.completeReload === false) return;
        tab.status = 'complete';
        for (const listener of [...tabsOnUpdated.listeners]) {
          await listener(tabId, { status: 'complete' }, { ...tab, id: tabId });
        }
      },
      create: async (createProperties) => {
        calls.push({ api: 'tabs.create', createProperties });
        return { ...tab, id: 8, url: createProperties.url, pendingUrl: createProperties.url };
      },
      update: async (tabId, updateProperties) => {
        calls.push({ api: 'tabs.update', tabId, updateProperties });
        return { ...tab, id: tabId, ...updateProperties };
      },
    },
    scripting: {
      async executeScript(details) {
        calls.push({ api: 'scripting.executeScript', details });
        if (typeof options.onExecuteScript === 'function') {
          await options.onExecuteScript({ details, calls });
        }
        // Per-call results (e.g. a different answer per injected function); a
        // throw here surfaces as executeScript rejecting, like an unscriptable page.
        if (typeof options.executeScriptResultFor === 'function') {
          return [{ result: await options.executeScriptResultFor(details) }];
        }
        return [{ result: options.executeScriptResult === undefined ? '' : options.executeScriptResult }];
      },
    },
    alarms: {
      onAlarm: event(),
      create: async (name, info) => { calls.push({ api: 'alarms.create', name, info }); },
      clear: async (name) => { calls.push({ api: 'alarms.clear', name }); return true; },
    },
    commands: { onCommand: event(), getAll: async () => (options.commands || []) },
    notifications: {
      onButtonClicked: event(),
      onClicked: event(),
      onClosed: event(),
      create: async (...args) => { calls.push({ api: 'notifications.create', args }); return 'notification'; },
      clear: async (...args) => { calls.push({ api: 'notifications.clear', args }); },
    },
    action: {
      setBadgeBackgroundColor: async (...args) => calls.push({ api: 'action.setBadgeBackgroundColor', args }),
      setBadgeText: async (...args) => calls.push({ api: 'action.setBadgeText', args }),
    },
    offscreen: {
      hasDocument: async () => false,
      createDocument: async (...args) => calls.push({ api: 'offscreen.createDocument', args }),
      closeDocument: async (...args) => calls.push({ api: 'offscreen.closeDocument', args }),
    },
    windows: { update: async (...args) => calls.push({ api: 'windows.update', args }) },
  };

  const context = vm.createContext({
    chrome,
    console,
    URL,
    URLPattern: global.URLPattern,
    AbortController,
    fetch: options.fetch || (async () => ({ ok: true, status: 200, text: async () => '' })),
    navigator: { onLine: true },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Promise,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    parseInt,
    isFinite,
  });
  context.importScripts = (...files) => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      vm.runInContext(source, context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'background.js'), 'utf8'), context, { filename: 'background.js' });

  async function dispatch(message, sender = { id: runtime.id }) {
    const listener = runtime.onMessage.listeners[0];
    if (!listener) throw new Error('background message listener was not registered');
    return new Promise((resolve, reject) => {
      let settled = false;
      const sendResponse = (response) => {
        if (!settled) {
          settled = true;
          // Responses originate in the VM realm; normalize them so Node's
          // strict assertions compare ordinary host objects.
          resolve(response === undefined ? response : JSON.parse(JSON.stringify(response)));
        }
      };
      try {
        listener(message, { id: runtime.id, ...sender }, sendResponse);
      } catch (error) {
        reject(error);
      }
    });
  }

  function evaluate(expression) {
    return vm.runInContext(expression, context);
  }

  return {
    chrome,
    calls,
    gates,
    storage,
    session: sessionStorage,
    sync: syncStorage,
    failures,
    dispatch,
    evaluate,
    releaseFirstTabGet() {
      if (gates.tabGetRelease) gates.tabGetRelease.resolve();
    },
  };
}

module.exports = { createHarness, deferred };
