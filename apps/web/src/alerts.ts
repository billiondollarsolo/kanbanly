/**
 * Fleet alert acknowledgement.
 *
 * Fleet issues are derived live from board state — visiting a board does not
 * make "2 P0 card(s) open" false. So the bell needs its own read state, kept
 * client-side in localStorage.
 */

export const ALERTS_ACK_KEY = "kanbanly.alertsAck";

export type AlertLike = { boardId: string; kind: string; message: string };

/**
 * Identity of an alert for acknowledgement purposes.
 *
 * The message is deliberately part of the key: acknowledging "2 P0 card(s)
 * open" must not also silence "5 P0 card(s) open". A worsening condition
 * produces a different key and resurfaces as unread.
 */
export function alertKey(i: AlertLike): string {
  return `${i.boardId}:${i.kind}:${i.message}`;
}

export function readAckedAlerts(): Set<string> {
  try {
    const raw = localStorage.getItem(ALERTS_ACK_KEY);
    if (!raw) return new Set();
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr)
      ? new Set(arr.filter((x): x is string => typeof x === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

export function writeAckedAlerts(keys: Set<string>): void {
  try {
    localStorage.setItem(ALERTS_ACK_KEY, JSON.stringify([...keys]));
  } catch {
    /* ignore */
  }
}

/**
 * Drop acknowledgements whose condition no longer exists. Keeps the stored set
 * bounded and ensures a resolved-then-recurring alert comes back unread.
 * Returns the same Set instance when nothing changed so callers can skip a
 * state update.
 */
export function pruneAcked(acked: Set<string>, live: Iterable<AlertLike>): Set<string> {
  const liveKeys = new Set([...live].map(alertKey));
  const next = new Set([...acked].filter((k) => liveKeys.has(k)));
  return next.size === acked.size ? acked : next;
}
