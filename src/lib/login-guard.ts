// Brute-force protection for the single credentials login.
// In-memory (one pod, Recreate strategy): after MAX_FAILURES failed attempts from the
// same client IP the login is locked for LOCK_MS, doubling on every further burst,
// capped at MAX_LOCK_MS. Successful login clears the counter.

export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60 * 1000;
export const MAX_LOCK_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 60 * 60 * 1000;

type Entry = { failures: number; lockedUntil: number; locks: number; last: number };

export class LoginGuard {
  private entries = new Map<string, Entry>();
  constructor(private now: () => number = Date.now) {}

  // Milliseconds remaining before this key may try again (0 = allowed).
  lockedFor(key: string): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    const t = this.now();
    if (e.lockedUntil > t) return e.lockedUntil - t;
    if (t - e.last > WINDOW_MS) this.entries.delete(key);
    return 0;
  }

  // Record a failure; returns the lock duration applied (0 when still below the threshold).
  fail(key: string): number {
    const t = this.now();
    const e = this.entries.get(key) ?? { failures: 0, lockedUntil: 0, locks: 0, last: t };
    if (t - e.last > WINDOW_MS && e.lockedUntil <= t) e.failures = 0;
    e.failures += 1;
    e.last = t;
    let applied = 0;
    if (e.failures >= MAX_FAILURES) {
      applied = Math.min(LOCK_MS * 2 ** e.locks, MAX_LOCK_MS);
      e.lockedUntil = t + applied;
      e.locks += 1;
      e.failures = 0;
    }
    this.entries.set(key, e);
    if (this.entries.size > 10_000) this.sweep(t);
    return applied;
  }

  succeed(key: string): void {
    this.entries.delete(key);
  }

  private sweep(t: number): void {
    for (const [k, e] of this.entries) if (e.lockedUntil <= t && t - e.last > WINDOW_MS) this.entries.delete(k);
  }
}

// Client IP as seen by Traefik (hostNetwork, so X-Forwarded-For's first hop is the LAN client).
export function clientIp(headers: Headers | undefined): string {
  const xff = headers?.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  if (first && /^[0-9a-f.:]{3,45}$/i.test(first)) return first;
  return headers?.get("x-real-ip")?.trim() || "unknown";
}

const globalForGuard = globalThis as unknown as { __dbmonLoginGuard?: LoginGuard };
export const loginGuard = (globalForGuard.__dbmonLoginGuard ??= new LoginGuard());
