// Ambient declarations for the page scripts' typecheck (tsconfig.pages.json).
// Not shipped.

// Page scripts read form controls by id and immediately use .value / .checked
// / .disabled. Typing getElementById as `any` here (page scripts only — the
// worker config does not include this file) trades checking those property
// names for not casting at ~120 call sites; everything else stays checked.
interface Document {
  getElementById(elementId: string): any;
}

// toast.js (Settings + Manage) and preset-row.js (popup + Settings) publish
// these on the page's global scope before the page script runs.
declare function showToast(message: string, isError?: boolean): void;
declare function buildPresetRow(doc: Document, preset: any, index: number): any;
declare function readPresets(doc: Document, count: number): { label: any; ms: number }[];

// content.js's re-injection guard.
interface Window {
  __autoRefreshInjected?: boolean;
  // preset-row.js publishes the built-in presets for the popup and Settings.
  DEFAULT_PRESETS: any[];
}
