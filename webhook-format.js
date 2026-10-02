// webhook-format.js — builds the Discord / Slack / generic-JSON body for one
// alert. Pure (no chrome.*, no network), so every format is unit-tested.
//
// When the alert carries per-item arrivals (info.items — each { key, href,
// text }), the message is upgraded to a one-tap form: a Discord embed / Slack
// link per study, so tapping it on a phone lands on the study itself, not the
// listing page. With no items it emits exactly the legacy flat message.
//
// Generic JSON carries schemaVersion so a consumer (e.g. a relay that dedupes
// and filters alerts) can detect shape changes. Version history:
//   1 — event/title/url/keyword/snippet/count/timestamp/items[]/itemsTruncated
//   2 — + schemaVersion, + items[].key (the extension's item hash); items[] capped
//       at JSON_ITEM_CAP instead of the chat formats' WEBHOOK_ITEM_CAP
//
// Loaded two ways:
//   • service worker:   importScripts('webhook-format.js') → globalThis.ARPWebhookFormat
//                       (after item-detect.js and validators.js)
//   • Node test runner: require('./webhook-format.js')       → module.exports
(function (/** @type {any} */ root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const api = isNode
    ? factory(require('./item-detect.js'), require('./validators.js'))
    : factory(root.ARPItemDetect, root.ARPValidators);
  if (isNode) module.exports = api;
  root.ARPWebhookFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ItemDetect, Validators) {
  'use strict';

  const SCHEMA_VERSION = 2;

  // Per-item alert renders at most this many arrivals inline; a larger burst is
  // summarized as "…and N more" so one cycle can't exceed Discord/Slack limits.
  const WEBHOOK_ITEM_CAP = 5;
  // Generic JSON feeds a machine consumer (a relay), not a chat window, so it
  // carries every arrival a burst realistically produces; the bound only keeps
  // a pathological page (readPageText allows 500 items) from bloating the POST.
  const JSON_ITEM_CAP = 100;

  // Slack mrkdwn treats & < > as control characters and uses <url|label> for
  // links, so a label carrying any of them corrupts parsing. Escape the three and
  // neutralize a stray pipe.
  function slackEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '/');
  }

  // Parse one arrival's card text into { meta, detail }: meta is the raw optional
  // fields (title/pay/places/researcher); detail is a compact "£/hr · N places ·
  // By X" one-liner for the alert body ('' when nothing parsed).
  function webhookItemDetail(text) {
    const meta = ItemDetect.parseItemMeta(text || '');
    const parts = [];
    if (meta.pay) parts.push(meta.pay);
    if (meta.places) parts.push(meta.places);
    if (meta.researcher) parts.push('By ' + meta.researcher);
    return { meta, detail: parts.join(' · ') };
  }

  // Build the format-specific JSON body for one alert.
  function buildBody(fmt, info) {
    const line = info.type === 'kw'
      ? ('🔔 Keyword ' + (info.inverse ? 'disappeared from' : 'found on') + ' “' + info.title + '”: ' + info.keyword)
      : ('🔔 Page changed: “' + info.title + '”' + (info.snippet ? ('\n' + info.snippet) : ''));
    const message = line + '\n' + info.url;

    // Per-item arrivals carry their own deep-link (the study), so when present we
    // render a richer one-tap payload instead of the flat listing-page line. Only
    // arrivals reach here (inverse/departures pass no items), so an item with no
    // usable link still shows its title. Absent items ⇒ exactly the legacy message.
    const items = Array.isArray(info.items) ? info.items.filter(it => it && it.text) : [];
    const shown = items.slice(0, WEBHOOK_ITEM_CAP);
    const more = items.length - shown.length;
    const summary = '🔔 ' + items.length + ' new for “' + (info.keyword || '') + '”'
      + (info.title ? (' on ' + info.title) : '');

    let body;
    if (fmt === 'discord') {
      if (shown.length) {
        const embeds = shown.map((it) => {
          const { meta, detail } = webhookItemDetail(it.text);
          const embed = { title: (meta.title || info.keyword || 'New match').slice(0, 256) };
          if (it.href && Validators.isSafeNavigableUrl(it.href)) embed.url = it.href;
          if (detail) embed.description = detail.slice(0, 4096);
          return embed;
        });
        let content = summary;
        if (more > 0) content += '\n…and ' + more + ' more';
        body = { content: content.slice(0, 2000), embeds };
      } else {
        body = { content: message };
      }
    } else if (fmt === 'slack') {
      if (shown.length) {
        const rows = shown.map((it) => {
          const { meta, detail } = webhookItemDetail(it.text);
          const label = slackEscape((meta.title || 'match').slice(0, 200));
          const linked = (it.href && Validators.isSafeNavigableUrl(it.href))
            ? ('<' + it.href + '|' + label + '>') : label;
          return '• ' + linked + (detail ? (' — ' + slackEscape(detail)) : '');
        });
        if (more > 0) rows.push('…and ' + more + ' more');
        body = { text: slackEscape(summary) + '\n' + rows.join('\n') };
      } else {
        body = { text: message };
      }
    } else {
      const jsonShown = items.slice(0, JSON_ITEM_CAP);
      body = {
        schemaVersion: SCHEMA_VERSION,
        event: info.type === 'kw' ? 'keyword' : 'change',
        title: info.title, url: info.url, keyword: info.keyword,
        snippet: info.snippet || '', count: info.count,
        timestamp: typeof info.now === 'number' ? info.now : Date.now(),
        items: jsonShown.map((it) => {
          const { meta } = webhookItemDetail(it.text);
          return {
            // The hash the extension diffs items on. It covers the card's TEXT, so
            // it changes when the card does (e.g. "12 places" → "11 places")
            // unless the job collapses digits (Ignore noise + digits). A consumer
            // should dedupe on `url` first; `key` is a fallback for link-less items.
            key: typeof it.key === 'string' ? it.key : '',
            title: meta.title || '',
            url: (it.href && Validators.isSafeNavigableUrl(it.href)) ? it.href : '',
            pay: meta.pay || '', places: meta.places || '', researcher: meta.researcher || '',
          };
        }),
        itemsTruncated: Math.max(0, items.length - jsonShown.length),
      };
    }
    return body;
  }

  return { SCHEMA_VERSION, WEBHOOK_ITEM_CAP, JSON_ITEM_CAP, slackEscape, webhookItemDetail, buildBody };
});
