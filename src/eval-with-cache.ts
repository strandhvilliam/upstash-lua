import type { RedisLike } from "./redis-like.ts"

/**
 * Cache for tracking which scripts have been loaded on each Redis client.
 *
 * Uses WeakMap so that when a Redis client is garbage collected, its
 * cache entries are automatically cleaned up.
 *
 * The inner Map stores Promises to handle concurrent load requests -
 * multiple calls for the same script will share a single SCRIPT LOAD.
 */
const loadCache = new WeakMap<RedisLike, Map<string, Promise<void>>>()

/**
 * Checks if an error is a Redis NOSCRIPT error.
 *
 * NOSCRIPT errors occur when attempting to execute a script via EVALSHA
 * but the script has not been loaded into the Redis script cache.
 *
 * @param error - The error to check
 * @returns True if the error indicates the script is not cached
 *
 * @since 0.1.0
 */
export function isNoScriptError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.toUpperCase().includes("NOSCRIPT")
  }
  if (typeof error === "string") {
    return error.toUpperCase().includes("NOSCRIPT")
  }
  return false
}

/**
 * Gets or creates the script load cache for a Redis client.
 *
 * @param redis - The Redis client instance
 * @returns The Map of SHA to load Promise
 */
function getClientCache(redis: RedisLike): Map<string, Promise<void>> {
  let cache = loadCache.get(redis)
  if (!cache) {
    cache = new Map()
    loadCache.set(redis, cache)
  }
  return cache
}

/**
 * Ensures a script is loaded on the Redis server.
 *
 * This function handles concurrent requests - if multiple calls arrive
 * for the same script before it's loaded, they all share the same
 * SCRIPT LOAD operation.
 *
 * @param redis - The Redis client
 * @param sha - The expected SHA1 hash of the script
 * @param script - The Lua script source code
 * @returns Promise that resolves when the script is loaded
 *
 * @since 0.1.0
 */
export async function ensureLoaded(redis: RedisLike, sha: string, script: string): Promise<void> {
  const cache = getClientCache(redis)

  const existing = cache.get(sha)
  if (existing) {
    return existing
  }

  const loadPromise = (async () => {
    await redis.scriptLoad(script)
  })()

  cache.set(sha, loadPromise)

  try {
    await loadPromise
  } catch (error) {
    cache.delete(sha)
    throw error
  }
}

/**
 * Options for executing a script with caching.
 *
 * @since 0.1.0
 */
export interface EvalWithCacheOptions {
  /** The Lua script source code */
  readonly script: string
  /** The SHA1 hash of the script */
  readonly sha: string
  /** Array of Redis keys (KEYS[1], KEYS[2], etc.) */
  readonly keys: string[]
  /** Array of arguments (ARGV[1], ARGV[2], etc.) */
  readonly args: string[]
}

/**
 * Executes a Lua script using EVALSHA with automatic NOSCRIPT fallback.
 *
 * This function implements the optimal execution strategy:
 * 1. Try EVALSHA first (most efficient, assumes script is cached)
 * 2. On NOSCRIPT error, load the script via SCRIPT LOAD
 * 3. Retry EVALSHA
 *
 * The script loading is cached per-client, so subsequent calls for the
 * same script won't trigger additional SCRIPT LOAD operations. Concurrent
 * calls for the same script share a single SCRIPT LOAD.
 *
 * @param redis - The Redis client to execute on
 * @param options - Script and parameters
 * @returns Promise resolving to the script's return value
 *
 * @example
 * ```ts
 * const result = await evalWithCache(redis, {
 *   script: 'return redis.call("GET", KEYS[1])',
 *   sha: "abc123...",
 *   keys: ["mykey"],
 *   args: [],
 * })
 * ```
 *
 * @since 0.1.0
 */
export async function evalWithCache(
  redis: RedisLike,
  options: EvalWithCacheOptions
): Promise<unknown> {
  const { script, sha, keys, args } = options

  try {
    return await redis.evalsha(sha, keys, args)
  } catch (error) {
    if (!isNoScriptError(error)) {
      throw error
    }

    await ensureLoaded(redis, sha, script)
    return await redis.evalsha(sha, keys, args)
  }
}
