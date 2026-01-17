/**
 * A minimal interface for Redis clients that support Lua script execution.
 *
 * This interface is designed to be compatible with Upstash Redis and other
 * Redis clients. The library does not directly depend on any specific
 * Redis client implementation.
 *
 * **Compatibility:**
 * - Upstash Redis (`@upstash/redis`) - Fully compatible
 *
 * @example
 * ```ts
 * import { Redis } from "@upstash/redis"
 *
 * const redis = new Redis({
 *   url: process.env.UPSTASH_REDIS_REST_URL,
 *   token: process.env.UPSTASH_REDIS_REST_TOKEN,
 * })
 *
 * // redis is compatible with RedisLike
 * await myScript.run(redis, { keys: { key: "test" } })
 * ```
 *
 * @since 0.1.0
 */
export interface RedisLike {
  /**
   * Executes a Lua script directly.
   *
   * This method sends the full script source to Redis for execution.
   * It is less efficient than `evalsha` for repeated executions of the
   * same script, as the script must be parsed each time.
   *
   * @param script - The Lua script source code
   * @param keys - Array of Redis keys used by the script (accessed as KEYS[1], KEYS[2], etc.)
   * @param args - Array of additional arguments (accessed as ARGV[1], ARGV[2], etc.)
   * @returns Promise resolving to the script's return value
   *
   * @example
   * ```ts
   * const result = await redis.eval(
   *   'return redis.call("GET", KEYS[1])',
   *   ["mykey"],
   *   []
   * )
   * ```
   */
  eval(script: string, keys: string[], args: string[]): Promise<unknown>

  /**
   * Executes a cached Lua script by its SHA1 hash.
   *
   * This is the preferred method for executing scripts, as it avoids
   * sending the full script source over the network. The script must
   * have been previously loaded using `scriptLoad`.
   *
   * If the script is not cached on the server, Redis returns a NOSCRIPT
   * error. The library handles this automatically by loading the script
   * and retrying.
   *
   * @param sha1 - The SHA1 hash of the script (40 hexadecimal characters)
   * @param keys - Array of Redis keys used by the script
   * @param args - Array of additional arguments
   * @returns Promise resolving to the script's return value
   * @throws Error with message containing "NOSCRIPT" if script is not cached
   *
   * @example
   * ```ts
   * const sha = await redis.scriptLoad('return "hello"')
   * const result = await redis.evalsha(sha, [], [])
   * ```
   */
  evalsha(sha1: string, keys: string[], args: string[]): Promise<unknown>

  /**
   * Loads a Lua script into the Redis script cache.
   *
   * The script is cached on the server and can be executed later using
   * `evalsha` with the returned SHA1 hash. This avoids sending the full
   * script source for each execution.
   *
   * @param script - The Lua script source code to cache
   * @returns Promise resolving to the SHA1 hash of the script
   *
   * @example
   * ```ts
   * const sha = await redis.scriptLoad('return redis.call("PING")')
   * console.log(sha) // "e.g., a42059b356c875f0717db19a51f6aaa9161e77a2"
   * ```
   */
  scriptLoad(script: string): Promise<string>
}
