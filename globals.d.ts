// Ambient declarations for `npm run typecheck` (tsc, no emit). Not shipped.
//
// The dependency-free modules publish themselves on globalThis (UMD-style) and
// the service worker reaches them as bare globals after importScripts. They are
// declared `any` here: tsc still checks the code INSIDE each module, while these
// cross-file seams stay loose.
declare var ARPValidators: any;
declare var ARPInterval: any;
declare var ARPKeyword: any;
declare var ARPItemDetect: any;
declare var ARPNormalize: any;
declare var ARPNotif: any;
declare var ARPRehydrate: any;
declare var ARPSerialize: any;
declare var ARPCompose: any;
declare var ARPMonitor: any;
declare var ARPGuards: any;
declare var ARPQuietHours: any;
declare var ARPLifecycle: any;
declare var ARPDetectionIdentity: any;
declare var ARPCheckpoint: any;
declare var ARPWebhook: any;
declare var ARPWebhookFormat: any;
declare var ARPWatchHealth: any;
declare var ARPSettingsSync: any;
declare var ARPSettingsExport: any;
declare var AlertSounds: any;
