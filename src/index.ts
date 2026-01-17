/**
 * upstash-lua - Type-safe Lua scripts for Upstash Redis
 *
 * This library provides a `defineScript()` function for creating type-safe
 * Lua scripts with StandardSchemaV1 validation (Zod, Effect Schema, ArkType, etc.).
 *
 * Features:
 * - Full TypeScript inference for keys, args, and return values
 * - Input validation and transformation using StandardSchemaV1 schemas
 * - Efficient EVALSHA execution with automatic NOSCRIPT fallback
 * - Universal runtime support (Node.js 18+, Bun, Edge runtimes)
 *
 * @example
 * ```ts
 * import { z } from "zod"
 * import { defineScript } from "upstash-lua"
 * import { Redis } from "@upstash/redis"
 *
 * const redis = new Redis({ url: "...", token: "..." })
 *
 * const rateLimit = defineScript({
 *   name: "rateLimit",
 *   lua: `
 *     local current = redis.call("INCR", KEYS[1])
 *     if current == 1 then
 *       redis.call("EXPIRE", KEYS[1], ARGV[2])
 *     end
 *     return { current <= tonumber(ARGV[1]) and 1 or 0, tonumber(ARGV[1]) - current }
 *   `,
 *   keys: { key: z.string() },
 *   args: {
 *     limit: z.number().int().positive().transform(String),
 *     windowSeconds: z.number().int().positive().transform(String),
 *   },
 *   returns: z.tuple([z.number(), z.number()]).transform(([allowed, rem]) => ({
 *     allowed: allowed === 1,
 *     remaining: rem,
 *   })),
 * })
 *
 * const result = await rateLimit.run(redis, {
 *   keys: { key: "rl:user:123" },
 *   args: { limit: 10, windowSeconds: 60 },
 * })
 * // result: { allowed: boolean, remaining: number }
 * ```
 *
 * @packageDocumentation
 * @module upstash-lua
 * @since 0.1.0
 */

// Version
export { VERSION } from "./version.ts"

// Main API
export { defineScript } from "./define-script.ts"
export type { Script, DefineScriptBase, LuaFunction } from "./define-script.ts"

// Lua tagged template
export { lua } from "./lua-template.ts"
export type { CompiledLua, LuaToken, TokenProxy } from "./lua-template.ts"

// Redis interface
export type { RedisLike } from "./redis-like.ts"

// Schema helpers
export { hashResult } from "./hash-result.ts"

// Types (for advanced users)
export type {
  AnyStandardSchema,
  StdInput,
  StdOutput,
  StringOutSchema,
  StringSchemaRecord,
  InputsOf,
  OutputsOf,
  ScriptCallInput,
  ScriptCallArgs,
} from "./types.ts"

// Utilities (for advanced users)
export {
  validateStandard,
  parseStandard,
} from "./standard-schema.ts"
export type {
  ValidationSuccess,
  ValidationFailure,
  ValidationResult,
  ParseContext,
} from "./standard-schema.ts"
