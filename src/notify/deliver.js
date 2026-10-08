// Channel abstraction + delivery with per-target records and retries.
// Adding a channel (email, etc.) = a class with { name, ok, why, targets(), send(target,msg) }.
import { WebPushChannel } from './channels/webpush.js';
import { TelegramChannel } from './channels/telegram.js';
import { J } from '../db.js';

export function buildChannels(cfg, env = process.env) {
  const prefs = cfg.preferences.channels || {};
  const list = [];
  const wp = new WebPushChannel({ publicKey: cfg.push.vapidPublicKey, privateKey: env.VAPID_PRIVATE_KEY, subject: cfg.push.subject, subscriptions: cfg.subscriptions.subscriptions });
  if (prefs.webpush !== false) list.push(wp);
  const tg = new TelegramChannel({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID });
  if (prefs.telegram !== false) list.push(tg);
  return list;
}

const MAX_ATTEMPTS = 3;

export async function deliverPending(db, channels, now) {
  const pending = db.prepare("SELECT * FROM notifications WHERE status='pending' AND (deliver_after IS NULL OR deliver_after<=?) ORDER BY created_at LIMIT 30").all(now);
  const live = channels.filter(c => c.ok);
  const dead = new Set(db.prepare('SELECT target FROM dead_targets').all().map(r => r.target));
  const stats = { notifications: pending.length, sent: 0, failed: 0, noChannel: 0 };
  const getDel = db.prepare('SELECT * FROM notification_deliveries WHERE notification_id=? AND channel=? AND target=?');
  const insDel = db.prepare('INSERT INTO notification_deliveries(notification_id,channel,target,status,error,attempts,last_attempt_at,sent_at) VALUES(?,?,?,?,?,1,?,?)');
  const updDel = db.prepare('UPDATE notification_deliveries SET status=?, error=?, attempts=attempts+1, last_attempt_at=?, sent_at=? WHERE id=?');
  for (const n of pending) {
    if (!live.length) {
      db.prepare("UPDATE notifications SET status='undeliverable', status_reason=? WHERE id=?").run('no notification channel configured: ' + channels.map(c => `${c.name} (${c.why})`).join('; '), n.id);
      stats.noChannel++;
      continue;
    }
    const msg = { title: n.title, body: n.body, url: n.url, level: n.level, kind: n.kind, tag: J(n.reason)?.tag || `n-${n.id}` };
    let anyOk = false, anyRetry = false;
    for (const ch of live) {
      for (const t of ch.targets()) {
        if (dead.has(t.id)) continue;
        const prev = getDel.get(n.id, ch.name, t.id);
        if (prev?.status === 'sent') { anyOk = true; continue; }
        if (prev && prev.attempts >= MAX_ATTEMPTS) continue;
        const r = await ch.send(t, msg);
        if (prev) updDel.run(r.ok ? 'sent' : 'failed', r.error || null, now, r.ok ? now : null, prev.id);
        else insDel.run(n.id, ch.name, t.id, r.ok ? 'sent' : 'failed', r.error || null, now, r.ok ? now : null);
        if (r.ok) { anyOk = true; stats.sent++; }
        else {
          stats.failed++;
          if (r.dead) db.prepare('INSERT OR REPLACE INTO dead_targets(target,channel,reason,at) VALUES(?,?,?,?)').run(t.id, ch.name, r.error, now);
          else if ((prev?.attempts || 0) + 1 < MAX_ATTEMPTS) anyRetry = true;
        }
      }
    }
    if (anyOk) db.prepare("UPDATE notifications SET status='sent' WHERE id=?").run(n.id);
    else if (!anyRetry) db.prepare("UPDATE notifications SET status='failed', status_reason='all delivery attempts failed' WHERE id=?").run(n.id);
  }
  return stats;
}
