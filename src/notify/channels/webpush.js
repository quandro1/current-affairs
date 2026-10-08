// Web Push (VAPID). Free: the browser vendor's push service (FCM / Mozilla / Apple) carries the message.
// Secrets: VAPID_PRIVATE_KEY (env). The public key is in config/push.json (safe to publish).
import webpush from 'web-push';
import { sha1 } from '../../text.js';

export class WebPushChannel {
  constructor({ publicKey, privateKey, subject, subscriptions, sender }) {
    this.name = 'webpush';
    this.subs = (subscriptions || []).filter(s => s?.endpoint && s?.keys?.p256dh && s?.keys?.auth);
    this.ok = !!(publicKey && privateKey && this.subs.length);
    this.sender = sender || webpush;
    if (publicKey && privateKey && !sender) webpush.setVapidDetails(subject || 'https://github.com', publicKey, privateKey);
    this.why = !publicKey || !privateKey ? 'VAPID keys not configured' : !this.subs.length ? 'no device subscribed yet' : null;
  }
  targets() { return this.subs.map(s => ({ id: 'wp:' + sha1(s.endpoint).slice(0, 16), sub: s, label: s.label || new URL(s.endpoint).hostname })); }
  async send(target, msg) {
    const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url, tag: msg.tag, level: msg.level, ts: Date.now() });
    try {
      await this.sender.sendNotification(target.sub, payload, { TTL: msg.level === 'critical' ? 6 * 3600 : 12 * 3600, urgency: msg.level === 'critical' ? 'high' : 'normal', topic: (msg.tag || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined });
      return { ok: true };
    } catch (e) {
      const gone = e.statusCode === 404 || e.statusCode === 410;
      return { ok: false, error: `${e.statusCode || ''} ${e.body || e.message}`.trim().slice(0, 300), dead: gone };
    }
  }
}
