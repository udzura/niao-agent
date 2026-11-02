import {journalDate} from "../../journal/src/core/validation";
const DAY = 86400000, TOKYO = 9 * 3600000;
export const tokyoDate = (now: number) => new Date(now + TOKYO).toISOString().slice(0, 10);
export const previousTokyoDate = (now: number) => tokyoDate(now - DAY);
// Latest day due at the most recent 07:00 JST; before 07:00 today's run is not due.
export const dueJournalDate = (now: number) => previousTokyoDate(now - 7 * 3600000);
export function journalRange(date: string) {
  journalDate.parse(date);
  const start = Date.parse(`${date}T00:00:00+09:00`);
  return {start: new Date(start).toISOString(), end: new Date(start + DAY).toISOString()};
}
export function redactJournalContext(value: string, secrets: (string | undefined)[] = []) {
  for (const secret of secrets) if (secret && secret.length >= 8) value = value.split(secret).join("[redacted credential]");
  return value.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted key]")
    .replace(/\bBearer\s+\S+|\b(?:sk-|gh[pousr]_)[a-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}/gi, "[redacted credential]")
    .replace(/(?:api[_-]?key|password|access[_-]?token|secret)\s*[=:]\s*["']?\S+/gi, "[redacted secret]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[redacted email]")
    .replace(/https?:\/\/[^\s<>"')]+/g, raw => {
      try {
        const url = new URL(raw);
        if (!url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname) || /\.(?:local|internal|test)$/.test(url.hostname) || url.username || url.password) return "[redacted private URL]";
        url.search = ""; url.hash = ""; return url.href;
      } catch { return "[redacted URL]"; }
    });
}
