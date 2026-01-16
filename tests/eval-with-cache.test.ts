import { describe, expect, test, beforeEach } from "bun:test"
import {
  evalWithCache,
  isNoScriptError,
  ensureLoaded,
} from "../src/eval-with-cache.ts"
import type { RedisLike } from "../src/redis-like.ts"

/**
 * Creates a fake Redis client for testing.
 */
function createFakeRedis(options?: {
  /** Number of NOSCRIPT errors before success (default: 1) */
  noscriptCount?: number
  /** Value to return from evalsha on success */
  returnValue?: unknown
}): RedisLike & {
  evalshaCallCount: number
  scriptLoadCallCount: number
  loadedScripts: Set<string>
} {
  const { noscriptCount = 1, returnValue = "OK" } = options ?? {}

  let evalshaAttempts = 0
  const loadedScripts = new Set<string>()

  return {
    evalshaCallCount: 0,
    scriptLoadCallCount: 0,
    loadedScripts,

    async eval(_script: string, _keys: string[], _args: string[]) {
      return returnValue
    },

    async evalsha(sha: string, _keys: string[], _args: string[]) {
      this.evalshaCallCount++
      evalshaAttempts++

      // Simulate NOSCRIPT error for first N attempts
      if (evalshaAttempts <= noscriptCount && !loadedScripts.has(sha)) {
        throw new Error("NOSCRIPT No matching script. Please use EVAL.")
      }

      return returnValue
    },

    async scriptLoad(script: string) {
      this.scriptLoadCallCount++
      // Simulate SHA generation (just use a hash of the script)
      const sha = `sha_${script.length}`
      loadedScripts.add(sha)
      return sha
    },
  }
}

describe("isNoScriptError", () => {
  test("returns true for NOSCRIPT Error", () => {
    const error = new Error("NOSCRIPT No matching script. Please use EVAL.")
    expect(isNoScriptError(error)).toBe(true)
  })

  test("returns true for lowercase noscript", () => {
    const error = new Error("noscript error occurred")
    expect(isNoScriptError(error)).toBe(true)
  })

  test("returns true for string error", () => {
    expect(isNoScriptError("NOSCRIPT No matching script")).toBe(true)
  })

  test("returns false for other errors", () => {
    const error = new Error("Connection refused")
    expect(isNoScriptError(error)).toBe(false)
  })

  test("returns false for non-error values", () => {
    expect(isNoScriptError(null)).toBe(false)
    expect(isNoScriptError(undefined)).toBe(false)
    expect(isNoScriptError(123)).toBe(false)
  })
})

describe("ensureLoaded", () => {
  test("loads script on first call", async () => {
    const redis = createFakeRedis()
    const script = 'return "hello"'
    const sha = "abc123"

    await ensureLoaded(redis, sha, script)

    expect(redis.scriptLoadCallCount).toBe(1)
  })

  test("only loads once for multiple calls", async () => {
    const redis = createFakeRedis()
    const script = 'return "hello"'
    const sha = "abc123"

    await ensureLoaded(redis, sha, script)
    await ensureLoaded(redis, sha, script)
    await ensureLoaded(redis, sha, script)

    expect(redis.scriptLoadCallCount).toBe(1)
  })

  test("concurrent calls share single load", async () => {
    const redis = createFakeRedis()
    const script = 'return "hello"'
    const sha = "abc123"

    // Start 10 concurrent loads
    const promises = Array.from({ length: 10 }, () =>
      ensureLoaded(redis, sha, script)
    )

    await Promise.all(promises)

    // Should only have called scriptLoad once
    expect(redis.scriptLoadCallCount).toBe(1)
  })

  test("different scripts are loaded separately", async () => {
    const redis = createFakeRedis()

    await ensureLoaded(redis, "sha1", "script1")
    await ensureLoaded(redis, "sha2", "script2")

    expect(redis.scriptLoadCallCount).toBe(2)
  })
})

describe("evalWithCache", () => {
  test("succeeds on first try when script is cached", async () => {
    const redis = createFakeRedis({ noscriptCount: 0, returnValue: 42 })

    const result = await evalWithCache(redis, {
      script: 'return 42',
      sha: "abc123",
      keys: [],
      args: [],
    })

    expect(result).toBe(42)
    expect(redis.evalshaCallCount).toBe(1)
    expect(redis.scriptLoadCallCount).toBe(0)
  })

  test("loads script on NOSCRIPT and retries", async () => {
    const redis = createFakeRedis({ noscriptCount: 1, returnValue: "success" })

    const result = await evalWithCache(redis, {
      script: 'return "success"',
      sha: "sha_17", // Matches the fake SHA generation
      keys: [],
      args: [],
    })

    expect(result).toBe("success")
    expect(redis.evalshaCallCount).toBe(2) // First fails, second succeeds
    expect(redis.scriptLoadCallCount).toBe(1)
  })

  test("passes keys and args correctly", async () => {
    let capturedKeys: string[] = []
    let capturedArgs: string[] = []

    const redis: RedisLike = {
      async eval() { return null },
      async evalsha(_sha, keys, args) {
        capturedKeys = keys
        capturedArgs = args
        return "OK"
      },
      async scriptLoad() { return "sha" },
    }

    await evalWithCache(redis, {
      script: "test",
      sha: "sha",
      keys: ["key1", "key2"],
      args: ["arg1", "arg2", "arg3"],
    })

    expect(capturedKeys).toEqual(["key1", "key2"])
    expect(capturedArgs).toEqual(["arg1", "arg2", "arg3"])
  })

  test("rethrows non-NOSCRIPT errors", async () => {
    const redis: RedisLike = {
      async eval() { return null },
      async evalsha() {
        throw new Error("Connection timeout")
      },
      async scriptLoad() { return "sha" },
    }

    try {
      await evalWithCache(redis, {
        script: "test",
        sha: "sha",
        keys: [],
        args: [],
      })
      expect(true).toBe(false) // Should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("Connection timeout")
    }
  })

  test("concurrent calls only trigger one SCRIPT LOAD", async () => {
    let loadCount = 0
    let evalshaCallCount = 0

    const redis: RedisLike = {
      async eval() { return null },
      async evalsha(sha) {
        evalshaCallCount++
        // First batch of calls get NOSCRIPT
        if (evalshaCallCount <= 10) {
          throw new Error("NOSCRIPT")
        }
        return "OK"
      },
      async scriptLoad() {
        loadCount++
        // Simulate some async delay
        await new Promise((r) => setTimeout(r, 10))
        return "sha"
      },
    }

    // Start 10 concurrent evals
    const promises = Array.from({ length: 10 }, () =>
      evalWithCache(redis, {
        script: "test",
        sha: "sha",
        keys: [],
        args: [],
      })
    )

    await Promise.all(promises)

    // Should only have one SCRIPT LOAD despite 10 concurrent NOSCRIPT errors
    expect(loadCount).toBe(1)
  })
})
