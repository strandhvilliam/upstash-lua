import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineScript } from "../src/define-script.ts"
import type { RedisLike } from "../src/redis-like.ts"

/**
 * Creates a mock Redis client for testing.
 */
function createMockRedis(options?: {
  returnValue?: unknown
  throwNoscript?: boolean
}): RedisLike & { calls: Array<{ method: string; args: unknown[] }> } {
  const { returnValue = "OK", throwNoscript = false } = options ?? {}
  let firstEvalsha = true

  return {
    calls: [],

    async eval(script, keys, args) {
      this.calls.push({ method: "eval", args: [script, keys, args] })
      return returnValue
    },

    async evalsha(sha, keys, args) {
      this.calls.push({ method: "evalsha", args: [sha, keys, args] })

      if (throwNoscript && firstEvalsha) {
        firstEvalsha = false
        throw new Error("NOSCRIPT")
      }

      return returnValue
    },

    async scriptLoad(script) {
      this.calls.push({ method: "scriptLoad", args: [script] })
      return "loaded_sha"
    },
  }
}

describe("defineScript", () => {
  test("creates script with correct metadata", () => {
    const script = defineScript({
      name: "testScript",
      lua: 'return "hello"',
      keys: {
        key1: z.string(),
        key2: z.string(),
      },
      args: {
        arg1: z.string(),
        arg2: z.string(),
        arg3: z.string(),
      },
    })

    expect(script.name).toBe("testScript")
    expect(script.lua).toBe('return "hello"')
    expect(script.keyNames).toEqual(["key1", "key2"])
    expect(script.argNames).toEqual(["arg1", "arg2", "arg3"])
  })

  test("preserves key/arg order from object literal", () => {
    const script = defineScript({
      name: "ordered",
      lua: "test",
      keys: {
        third: z.string(),
        first: z.string(),
        second: z.string(),
      },
      args: {
        c: z.string(),
        a: z.string(),
        b: z.string(),
      },
    })

    // Order should match object literal order (insertion order)
    expect(script.keyNames).toEqual(["third", "first", "second"])
    expect(script.argNames).toEqual(["c", "a", "b"])
  })

  test("allows optional keys and args", () => {
    const script = defineScript({
      name: "optional",
      lua: 'return "test"',
    })

    expect(script.keyNames).toEqual([])
    expect(script.argNames).toEqual([])
  })

  test("allows optional args only", () => {
    const script = defineScript({
      name: "onlyKeys",
      lua: "test",
      keys: { key: z.string() },
    })

    expect(script.keyNames).toEqual(["key"])
    expect(script.argNames).toEqual([])
  })

  test("allows optional keys only", () => {
    const script = defineScript({
      name: "onlyArgs",
      lua: "test",
      args: { arg: z.string() },
    })

    expect(script.keyNames).toEqual([])
    expect(script.argNames).toEqual(["arg"])
  })
})

describe("script.run()", () => {
  test("executes with validated keys and args", async () => {
    const redis = createMockRedis({ returnValue: 42 })

    const script = defineScript({
      name: "test",
      lua: 'return redis.call("GET", KEYS[1])',
      keys: { key: z.string() },
      args: { limit: z.number().transform(String) },
      returns: z.number(),
    })

    const result = await script.run(redis, {
      keys: { key: "mykey" },
      args: { limit: 10 },
    })

    expect(result).toBe(42)

    // Check that evalsha was called with correct keys/args
    const evalshaCall = redis.calls.find((c) => c.method === "evalsha")
    expect(evalshaCall).toBeDefined()
    expect(evalshaCall!.args[1]).toEqual(["mykey"]) // keys
    expect(evalshaCall!.args[2]).toEqual(["10"]) // args (transformed to string)
  })

  test("transforms args using schema transforms", async () => {
    const redis = createMockRedis({ returnValue: "OK" })

    const script = defineScript({
      name: "transform",
      lua: "test",
      keys: {},
      args: {
        number: z.number().transform(String),
        boolean: z.boolean().transform((b) => (b ? "1" : "0")),
      },
    })

    await script.run(redis, {
      args: { number: 42, boolean: true },
    })

    const evalshaCall = redis.calls.find((c) => c.method === "evalsha")
    expect(evalshaCall!.args[2]).toEqual(["42", "1"])
  })

  test("validates and transforms return value", async () => {
    const redis = createMockRedis({ returnValue: [1, 5] })

    const script = defineScript({
      name: "rateLimit",
      lua: "test",
      keys: { key: z.string() },
      args: {},
      returns: z.tuple([z.number(), z.number()]).transform(([allowed, remaining]) => ({
        allowed: allowed === 1,
        remaining,
      })),
    })

    const result = await script.run(redis, {
      keys: { key: "test" },
    })

    expect(result).toEqual({ allowed: true, remaining: 5 })
  })

  test("returns unknown when no returns schema", async () => {
    const redis = createMockRedis({ returnValue: { complex: "data" } })

    const script = defineScript({
      name: "noReturns",
      lua: "test",
      keys: {},
      args: {},
    })

    const result = await script.run(redis)

    expect(result).toEqual({ complex: "data" })
  })

  test("works with empty keys and args (no second argument)", async () => {
    const redis = createMockRedis({ returnValue: "PONG" })

    const ping = defineScript({
      name: "ping",
      lua: 'return redis.call("PING")',
      keys: {},
      args: {},
      returns: z.string(),
    })

    // Should be callable with just redis (no second argument)
    const result = await ping.run(redis)

    expect(result).toBe("PONG")
  })

  test("throws Error for invalid input", async () => {
    const redis = createMockRedis()

    const script = defineScript({
      name: "rateLimit",
      lua: "test",
      keys: { key: z.string() },
      args: { limit: z.number().positive().transform(String) },
    })

    try {
      await script.run(redis, {
        keys: { key: "test" },
        args: { limit: -1 }, // Invalid: not positive
      })
      expect(true).toBe(false) // Should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      if (error instanceof Error) {
        expect(error.message).toContain("rateLimit")
        expect(error.message).toContain("args.limit")
        expect(error.message).toContain("input validation failed")
      }
    }
  })

  test("throws Error for invalid return", async () => {
    const redis = createMockRedis({ returnValue: "not a number" })

    const script = defineScript({
      name: "increment",
      lua: "test",
      keys: {},
      args: {},
      returns: z.number(),
    })

    try {
      await script.run(redis)
      expect(true).toBe(false) // Should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      if (error instanceof Error) {
        expect(error.message).toContain("increment")
        expect(error.message).toContain("return validation failed")
      }
    }
  })

  test("handles NOSCRIPT error and retries", async () => {
    const redis = createMockRedis({ returnValue: "OK", throwNoscript: true })

    const script = defineScript({
      name: "test",
      lua: "return OK",
      keys: {},
      args: {},
      returns: z.string(),
    })

    const result = await script.run(redis)

    expect(result).toBe("OK")

    // Should have: evalsha (fail) -> scriptLoad -> evalsha (success)
    const methodCalls = redis.calls.map((c) => c.method)
    expect(methodCalls).toContain("evalsha")
    expect(methodCalls).toContain("scriptLoad")
  })
})

describe("script.runRaw()", () => {
  test("returns raw Redis response without validation", async () => {
    const redis = createMockRedis({ returnValue: [1, 2, 3] })

    const script = defineScript({
      name: "test",
      lua: "test",
      keys: {},
      args: {},
      returns: z.string(), // Would fail validation
    })

    // runRaw should return raw value without validating against returns schema
    const result = await script.runRaw(redis)

    expect(result).toEqual([1, 2, 3])
  })

  test("still validates inputs", async () => {
    const redis = createMockRedis()

    const script = defineScript({
      name: "test",
      lua: "test",
      keys: { key: z.string().min(1) },
      args: {},
    })

    try {
      await script.runRaw(redis, { keys: { key: "" } }) // Invalid: empty string
      expect(true).toBe(false)
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
    }
  })
})

describe("Type inference", () => {
  test("infers input types from schemas", async () => {
    const redis = createMockRedis({ returnValue: 1 })

    const script = defineScript({
      name: "typed",
      lua: "test",
      keys: { userId: z.string() },
      args: {
        limit: z.number().transform(String),
        enabled: z.boolean().transform((b) => (b ? "1" : "0")),
      },
      returns: z.number(),
    })

    // This should type-check correctly:
    // - keys.userId expects string
    // - args.limit expects number (input type, not output)
    // - args.enabled expects boolean
    // - result is number
    const result = await script.run(redis, {
      keys: { userId: "user123" },
      args: { limit: 10, enabled: true },
    })

    // Result should be typed as number
    const typed: number = result
    expect(typed).toBe(1)
  })
})

describe("Real-world examples from spec", () => {
  test("rate limit example", async () => {
    const redis = createMockRedis({ returnValue: [1, 9] })

    const rateLimit = defineScript({
      name: "rateLimit",
      lua: `
        local current = redis.call("INCR", KEYS[1])
        if current == 1 then
          redis.call("EXPIRE", KEYS[1], ARGV[2])
        end
        local allowed = current <= tonumber(ARGV[1]) and 1 or 0
        return { allowed, tonumber(ARGV[1]) - current }
      `,
      keys: {
        key: z.string(),
      },
      args: {
        limit: z.number().int().positive().transform(String),
        windowSeconds: z.number().int().positive().transform(String),
      },
      returns: z.tuple([z.number(), z.number()]).transform(([allowed, rem]) => ({
        allowed: allowed === 1,
        remaining: rem,
      })),
    })

    const out = await rateLimit.run(redis, {
      keys: { key: "rl:u:123" },
      args: { limit: 10, windowSeconds: 60 },
    })

    expect(out.allowed).toBe(true)
    expect(out.remaining).toBe(9)
  })

  test("ping example (no keys/args)", async () => {
    const redis = createMockRedis({ returnValue: "PONG" })

    const ping = defineScript({
      name: "ping",
      lua: 'return redis.call("PING")',
      keys: {},
      args: {},
      returns: z.string(),
    })

    const res = await ping.run(redis)
    expect(res).toBe("PONG")
  })
})
