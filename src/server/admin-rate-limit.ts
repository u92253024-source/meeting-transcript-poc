interface AttemptState {
  failures: number;
  windowStartedAt: number;
  blockedUntil: number;
}

export type AttemptDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export class AdminRateLimiter {
  private readonly attempts = new Map<string, AttemptState>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 60_000,
    private readonly blockMs = 60_000,
  ) {}

  check(key: string, now = Date.now()): AttemptDecision {
    const state = this.attempts.get(key);
    if (!state) return { allowed: true };
    if (state.blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - now) / 1_000)) };
    }
    if (now - state.windowStartedAt >= this.windowMs) this.attempts.delete(key);
    return { allowed: true };
  }

  recordFailure(key: string, now = Date.now()): void {
    const current = this.attempts.get(key);
    const state = !current || now - current.windowStartedAt >= this.windowMs
      ? { failures: 0, windowStartedAt: now, blockedUntil: 0 }
      : current;
    state.failures += 1;
    if (state.failures >= this.maxFailures) state.blockedUntil = now + this.blockMs;
    this.attempts.set(key, state);
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }
}
