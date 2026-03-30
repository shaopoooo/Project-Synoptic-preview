/**
 * Centralized LRU cache instances for all services.
 * Prevents unbounded memory growth and provides a single place for
 * cache snapshot / restore (state persistence).
 */
import { LRUCache } from 'lru-cache';
import { VolatilityEntry, HistoricalReturnsEntry, PoolVolEntry } from '../types';

// ── PoolMarketService ─────────────────────────────────────────────────────────────────
// 30D annualized volatility per pool address (TTL tracked via expiresAt field)
export const volatilityCache = new LRUCache<string, VolatilityEntry>({ max: 100 });

// 180D historical log returns per pool address（Bootstrap MC 用，24h TTL）
export const historicalReturnsCache = new LRUCache<string, HistoricalReturnsEntry>({ max: 50 });

// ── PoolScanner ───────────────────────────────────────────────────────────────
// 24h / 7d volume per pool address (TTL tracked via expiresAt field)
export const poolVolCache = new LRUCache<string, PoolVolEntry>({ max: 100 });

// ── Helpers ───────────────────────────────────────────────────────────────────
/** Snapshot an LRUCache to a plain object (for JSON serialization). */
export function snapshotCache<V extends object>(cache: LRUCache<string, V>): Record<string, V> {
    const out: Record<string, V> = {};
    for (const [k, v] of cache.entries()) out[k] = v;
    return out;
}

/** Restore an LRUCache from a plain object snapshot, skipping expired entries. */
export function restoreCache<V extends { expiresAt: number }>(
    cache: LRUCache<string, V>,
    data: Record<string, V>
) {
    const now = Date.now();
    for (const [k, v] of Object.entries(data)) {
        if (v.expiresAt > now) cache.set(k, v);
    }
}
