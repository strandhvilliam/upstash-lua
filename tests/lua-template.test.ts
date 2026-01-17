import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineScript, lua } from "../src/index.ts"
import {
  LUA_TOKEN,
  compileLua,
  createTokenProxy,
  isCompiledLua,
  isLuaToken,
} from "../src/lua-template.ts"
import type { RedisLike } from "../src/redis-like.ts"

/**
 * Creates a mock Redis client for testing.
 */
function createMockRedis(options?: {
  returnValue?: unknown
}): RedisLike & { calls: Array<{ method: string; args: unknown[] }> } {
  const { returnValue = "OK" } = options ?? {}

  return {
    calls: [],

    async eval(script, keys, args) {
      this.calls.push({ method: "eval", args: [script, keys, args] })
      return returnValue
    },

    async evalsha(sha, keys, args) {
      this.calls.push({ method: "evalsha", args: [sha, keys, args] })
      return returnValue
    },

    async scriptLoad(script) {
      this.calls.push({ method: "scriptLoad", args: [script] })
      return "loaded_sha"
    },
  }
}

describe("LuaToken", () => {
  test("createTokenProxy returns tokens for property access", () => {
    const KEYS = createTokenProxy<{ userKey: unknown; otherKey: unknown }>("key")

    const token = KEYS.userKey
    expect(isLuaToken(token)).toBe(true)
    expect(token.kind).toBe("key")
    expect(token.name).toBe("userKey")
  })

  test("createTokenProxy works for ARGV", () => {
    const ARGV = createTokenProxy<{ limit: unknown; window: unknown }>("arg")

    const token = ARGV.limit
    expect(isLuaToken(token)).toBe(true)
    expect(token.kind).toBe("arg")
    expect(token.name).toBe("limit")
  })

  test("isLuaToken returns false for non-tokens", () => {
    expect(isLuaToken("string")).toBe(false)
    expect(isLuaToken(123)).toBe(false)
    expect(isLuaToken(null)).toBe(false)
    expect(isLuaToken(undefined)).toBe(false)
    expect(isLuaToken({})).toBe(false)
    expect(isLuaToken({ kind: "key", name: "test" })).toBe(false) // Missing symbol
  })
})

describe("lua tagged template", () => {
  test("captures strings and tokens", () => {
    const KEYS = createTokenProxy<{ key: unknown }>("key")
    const ARGV = createTokenProxy<{ limit: unknown }>("arg")

    const compiled = lua`
      local key = ${KEYS.key}
      local limit = ${ARGV.limit}
      return key
    `

    expect(isCompiledLua(compiled)).toBe(true)
    expect(compiled.strings.length).toBe(3)
    expect(compiled.tokens.length).toBe(2)
    expect(compiled.tokens[0]!.kind).toBe("key")
    expect(compiled.tokens[0]!.name).toBe("key")
    expect(compiled.tokens[1]!.kind).toBe("arg")
    expect(compiled.tokens[1]!.name).toBe("limit")
  })

  test("throws for non-token interpolations", () => {
    expect(() => {
      // @ts-expect-error - Testing runtime error for invalid interpolation
      lua`local x = ${"string"}`
    }).toThrow(/lua template only accepts KEYS\.\* or ARGV\.\* interpolations/)
  })
})

describe("compileLua", () => {
  test("compiles tokens to positional references", () => {
    const KEYS = createTokenProxy<{ userKey: unknown; sessionKey: unknown }>("key")
    const ARGV = createTokenProxy<{ limit: unknown; window: unknown }>("arg")

    const compiled = lua`
      local key = ${KEYS.userKey}
      local session = ${KEYS.sessionKey}
      local limit = ${ARGV.limit}
      local window = ${ARGV.window}
      return { key, session, limit, window }
    `

    const result = compileLua(
      compiled,
      ["userKey", "sessionKey"],
      ["limit", "window"]
    )

    expect(result).toContain("KEYS[1]")
    expect(result).toContain("KEYS[2]")
    expect(result).toContain("ARGV[1]")
    expect(result).toContain("ARGV[2]")
    expect(result).not.toContain("${")
  })

  test("preserves order based on schema", () => {
    const KEYS = createTokenProxy<{ second: unknown; first: unknown }>("key")

    const compiled = lua`
      local a = ${KEYS.first}
      local b = ${KEYS.second}
    `

    // Schema order: second=1, first=2
    const result = compileLua(compiled, ["second", "first"], [])

    // first should be KEYS[2] because it's second in the schema
    expect(result).toContain("KEYS[2]") // first
    expect(result).toContain("KEYS[1]") // second

    // Verify the order in the output
    const firstIndex = result.indexOf("KEYS[2]")
    const secondIndex = result.indexOf("KEYS[1]")
    expect(firstIndex).toBeLessThan(secondIndex)
  })

  test("throws for unknown key reference", () => {
    const KEYS = createTokenProxy<{ unknownKey: unknown }>("key")

    const compiled = lua`local x = ${KEYS.unknownKey}`

    expect(() => {
      compileLua(compiled, ["actualKey"], [])
    }).toThrow(/Unknown key "unknownKey"/)
  })

  test("throws for unknown arg reference", () => {
    const ARGV = createTokenProxy<{ unknownArg: unknown }>("arg")

    const compiled = lua`local x = ${ARGV.unknownArg}`

    expect(() => {
      compileLua(compiled, [], ["actualArg"])
    }).toThrow(/Unknown arg "unknownArg"/)
  })
})

describe("defineScript with lua function", () => {
  test("compiles lua function to string", () => {
    const script = defineScript({
      name: "test",
      keys: { userKey: z.string() },
      args: { limit: z.number().transform(String) },
      lua: ({ KEYS, ARGV }) => lua`
        local key = ${KEYS.userKey}
        local limit = tonumber(${ARGV.limit})
        return { key, limit }
      `,
    })

    expect(script.lua).toContain("KEYS[1]")
    expect(script.lua).toContain("ARGV[1]")
    expect(script.lua).not.toContain("${")
    expect(script.lua).not.toContain("KEYS.userKey")
  })

  test("executes script with lua function", async () => {
    const redis = createMockRedis({ returnValue: ["u:123", 5] })

    const script = defineScript({
      name: "test",
      keys: { userKey: z.string() },
      args: { limit: z.number().transform(String) },
      lua: ({ KEYS, ARGV }) => lua`
        local key = ${KEYS.userKey}
        local limit = tonumber(${ARGV.limit})
        return { key, limit }
      `,
      returns: z.tuple([z.string(), z.number()]),
    })

    const result = await script.run(redis, {
      keys: { userKey: "u:123" },
      args: { limit: 5 },
    })

    expect(result).toEqual(["u:123", 5])

    // Verify the compiled Lua was sent
    const evalshaCall = redis.calls.find((c) => c.method === "evalsha")
    expect(evalshaCall).toBeDefined()
    expect(evalshaCall!.args[1]).toEqual(["u:123"])
    expect(evalshaCall!.args[2]).toEqual(["5"])
  })

  test("backward compatibility: lua string still works", async () => {
    const redis = createMockRedis({ returnValue: "OK" })

    const script = defineScript({
      name: "test",
      keys: { key: z.string() },
      args: {},
      lua: `return redis.call("GET", KEYS[1])`,
      returns: z.string(),
    })

    expect(script.lua).toBe(`return redis.call("GET", KEYS[1])`)

    const result = await script.run(redis, { keys: { key: "test" } })
    expect(result).toBe("OK")
  })

  test("throws if lua function doesn't return CompiledLua", () => {
    expect(() => {
      defineScript({
        name: "test",
        keys: {},
        args: {},
        // @ts-expect-error - Testing runtime error
        lua: () => "not a compiled lua",
      })
    }).toThrow(/lua function must return a lua`...` template/)
  })
})

describe("Real-world example from spec", () => {
  test("rate limit example with lua function", async () => {
    const redis = createMockRedis({ returnValue: [1, 9] })

    const rateLimit = defineScript({
      name: "rateLimit",
      keys: { key: z.string() },
      args: {
        limit: z.number().int().positive().transform(String),
        windowSeconds: z.number().int().positive().transform(String),
      },
      lua: ({ KEYS, ARGV }) => lua`
        local key = ${KEYS.key}
        local limit = tonumber(${ARGV.limit})
        local window = tonumber(${ARGV.windowSeconds})

        local current = redis.call("INCR", key)
        if current == 1 then
          redis.call("EXPIRE", key, window)
        end

        return { current <= limit and 1 or 0, math.max(0, limit - current) }
      `,
      returns: z.tuple([z.number(), z.number()]).transform(([allowed, remaining]) => ({
        allowed: allowed === 1,
        remaining,
      })),
    })

    // Verify the compiled Lua
    expect(rateLimit.lua).toContain("KEYS[1]")
    expect(rateLimit.lua).toContain("ARGV[1]")
    expect(rateLimit.lua).toContain("ARGV[2]")
    expect(rateLimit.lua).not.toContain("${")

    // Execute
    const out = await rateLimit.run(redis, {
      keys: { key: "rl:u:123" },
      args: { limit: 10, windowSeconds: 60 },
    })

    expect(out.allowed).toBe(true)
    expect(out.remaining).toBe(9)

    // Verify args were passed correctly
    const evalshaCall = redis.calls.find((c) => c.method === "evalsha")
    expect(evalshaCall!.args[1]).toEqual(["rl:u:123"])
    expect(evalshaCall!.args[2]).toEqual(["10", "60"])
  })
})

describe("Type safety", () => {
  test("KEYS and ARGV are typed based on schema", () => {
    // This test verifies compile-time type safety
    // If the types are wrong, TypeScript will error

    const script = defineScript({
      name: "typed",
      keys: {
        userId: z.string(),
        sessionId: z.string(),
      },
      args: {
        limit: z.number().transform(String),
        enabled: z.boolean().transform((b) => (b ? "1" : "0")),
      },
      lua: ({ KEYS, ARGV }) => {
        // These should all type-check correctly
        const _userId = KEYS.userId
        const _sessionId = KEYS.sessionId
        const _limit = ARGV.limit
        const _enabled = ARGV.enabled

        // @ts-expect-error - unknownKey doesn't exist
        const _unknown = KEYS.unknownKey

        return lua`
          local userId = ${KEYS.userId}
          local sessionId = ${KEYS.sessionId}
          local limit = ${ARGV.limit}
          local enabled = ${ARGV.enabled}
          return { userId, sessionId, limit, enabled }
        `
      },
    })

    // Verify it compiled correctly
    expect(script.lua).toContain("KEYS[1]")
    expect(script.lua).toContain("KEYS[2]")
    expect(script.lua).toContain("ARGV[1]")
    expect(script.lua).toContain("ARGV[2]")
  })
})

describe("Edge cases", () => {
  test("empty keys and args", () => {
    const script = defineScript({
      name: "noKeysArgs",
      keys: {},
      args: {},
      lua: ({ KEYS: _KEYS, ARGV: _ARGV }) => lua`
        return redis.call("PING")
      `,
      returns: z.string(),
    })

    expect(script.lua).toContain("PING")
    expect(script.keyNames).toEqual([])
    expect(script.argNames).toEqual([])
  })

  test("multiple references to same key/arg", () => {
    const script = defineScript({
      name: "multiRef",
      keys: { key: z.string() },
      args: { value: z.string() },
      lua: ({ KEYS, ARGV }) => lua`
        local k1 = ${KEYS.key}
        local k2 = ${KEYS.key}
        local v1 = ${ARGV.value}
        local v2 = ${ARGV.value}
        return { k1, k2, v1, v2 }
      `,
    })

    // Should have multiple KEYS[1] and ARGV[1] references
    const keyMatches = script.lua.match(/KEYS\[1\]/g)
    const argMatches = script.lua.match(/ARGV\[1\]/g)
    expect(keyMatches?.length).toBe(2)
    expect(argMatches?.length).toBe(2)
  })

  test("preserves whitespace and formatting", () => {
    const script = defineScript({
      name: "formatted",
      keys: { key: z.string() },
      args: {},
      lua: ({ KEYS }) => lua`
        -- Comment
        local key = ${KEYS.key}

        if true then
          return key
        end
      `,
    })

    expect(script.lua).toContain("-- Comment")
    expect(script.lua).toContain("if true then")
    expect(script.lua).toContain("\n")
  })
})
