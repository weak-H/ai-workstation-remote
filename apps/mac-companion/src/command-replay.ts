const defaultMaxEntries = 10_000;

export class CommandReplayGuard {
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries = defaultMaxEntries) {}

  accept(nonce: string, expiresAt: string, now = Date.now()): boolean {
    for (const [knownNonce, expiry] of this.entries) {
      if (expiry <= now) this.entries.delete(knownNonce);
    }
    if (this.entries.has(nonce)) return false;
    if (this.entries.size >= this.maxEntries) return false;
    this.entries.set(nonce, Date.parse(expiresAt));
    return true;
  }

  get size(): number {
    return this.entries.size;
  }
}
