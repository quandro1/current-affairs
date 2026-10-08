// Optional Telegram channel via the free Bot API. Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (env).
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class TelegramChannel {
  constructor({ token, chatId, fetchImpl }) {
    this.name = 'telegram';
    this.token = token; this.chatId = chatId; this.fetch = fetchImpl || fetch;
    this.ok = !!(token && chatId);
    this.why = this.ok ? null : 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set';
  }
  targets() { return this.ok ? [{ id: 'tg:' + String(this.chatId).slice(-6), label: 'Telegram' }] : []; }
  async send(target, msg) {
    const [first, ...rest] = String(msg.body || '').split('\n');
    const text = `<b>${esc(msg.title)}</b>\n\n<b>${esc(first)}</b>\n${rest.map(esc).join('\n')}${msg.url ? `\n\n<a href="${esc(msg.url)}">Open in app →</a>` : ''}`;
    try {
      const r = await this.fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: false }),
        signal: AbortSignal.timeout(15000)
      });
      const j = await r.json().catch(() => ({}));
      return j.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status} ${j.description || ''}`.trim() };
    } catch (e) { return { ok: false, error: e.message }; }
  }
}
