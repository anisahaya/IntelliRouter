export interface AffinityRecord {
  modelId: string;
  expiresAt: number;
}

export class AffinityCache {
  readonly #records = new Map<string, AffinityRecord>();

  get(sessionHash: string, now = Date.now()): string | undefined {
    const record = this.#records.get(sessionHash);
    if (!record) return undefined;
    if (record.expiresAt <= now) {
      this.#records.delete(sessionHash);
      return undefined;
    }
    return record.modelId;
  }

  set(sessionHash: string, modelId: string, ttlSeconds: number, now = Date.now()): void {
    this.#records.set(sessionHash, { modelId, expiresAt: now + ttlSeconds * 1000 });
  }
}
