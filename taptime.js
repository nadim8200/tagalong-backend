// Taps made without signal (Nov 21, 2026): the driver app keeps "arrived", "delivered", a check-in or a box count on the phone
// and sends it when signal comes back, with `tappedAt` = when the driver pressed it. We keep that time (it is what the wait
// clock and the progress emails need), never in the future and at most 24 h back; when it came in late we note the real arrival.
const DAY = 24 * 3600000;
export function tapTime(body, nowMs) {
  const t = Date.parse(String((body || {}).tappedAt || ''));
  return new Date(Number.isFinite(t) ? Math.min(nowMs, Math.max(nowMs - DAY, t)) : nowMs).toISOString();
}
// { at, sentAt? }: sentAt only when the tap got here more than 2 minutes after it was pressed
export function tapStamp(body, nowMs) {
  const at = tapTime(body, nowMs);
  return nowMs - Date.parse(at) > 2 * 60000 ? { at, sentAt: new Date(nowMs).toISOString() } : { at };
}
