import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { RedisLike } from "./redis-like.ts"
import type {
  AnyStandardSchema,
  ScriptCallArgs,
  StdInput,
  StdOutput,
  StringSchemaRecord,
} from "./types.ts"
import { parseStandard } from "./standard-schema.ts"
import { evalWithCache } from "./eval-with-cache.ts"
import { sha1Hex } from "./sha1.ts"

/**
 * Represents a defined Lua script with type-safe execution methods.
 *
 * The Script object is created by `defineScript()` and provides methods
 * to execute the script with validated inputs and typed outputs.
 *
 * @typeParam K - The keys schema record
 * @typeParam A - The args schema record
 * @typeParam R - The return type after validation
 *
 * @example
 * ```ts
 * const myScript: Script<{ key: z.ZodString }, { limit: z.ZodNumber }, number> = defineScript({
 *   name: "myScript",
 *   lua: `return redis.call("INCR", KEYS[1])`,
 *   keys: { key: z.string() },
 *   args: { limit: z.number().transform(String) },
 *   returns: z.number(),
 * })
 * ```
 *
 * @since 0.1.0
 */
export interface Script<K extends StringSchemaRecord, A extends StringSchemaRecord, R> {
  /**
   * Human-readable name of the script.
   * Used in error messages for debugging.
   */
  readonly name: string

  /**
   * The Lua script source code.
   */
  readonly lua: string

  /**
   * Ordered list of key names.
   * The order matches KEYS[1], KEYS[2], etc. in the Lua script.
   * Derived from `Object.keys(def.keys)` at definition time.
   */
  readonly keyNames: readonly Extract<keyof K, string>[]

  /**
   * Ordered list of argument names.
   * The order matches ARGV[1], ARGV[2], etc. in the Lua script.
   * Derived from `Object.keys(def.args)` at definition time.
   */
  readonly argNames: readonly Extract<keyof A, string>[]

  /**
   * Executes the script without validating the return value.
   *
   * Use this when you don't need return validation or want to handle
   * the raw Redis response yourself.
   *
   * @param redis - The Redis client to execute on
   * @param input - The keys and args (omit if both are empty)
   * @returns Promise resolving to the raw Redis response
   *
   * @example
   * ```ts
   * const raw = await myScript.runRaw(redis, {
   *   keys: { key: "test" },
   *   args: { limit: 10 },
   * })
   * ```
   *
   * @since 0.1.0
   */
  runRaw(redis: RedisLike, ...input: ScriptCallArgs<K, A>): Promise<unknown>

  /**
   * Executes the script with full input and return validation.
   *
   * This is the primary method for executing scripts. It:
   * 1. Validates all keys and args against their schemas
   * 2. Transforms validated values (e.g., numbers to strings)
   * 3. Executes the script via EVALSHA (with NOSCRIPT fallback)
   * 4. Validates and transforms the return value (if returns schema provided)
   *
   * @param redis - The Redis client to execute on
   * @param input - The keys and args (omit if both are empty)
   * @returns Promise resolving to the validated and transformed return value
   * @throws {ScriptInputError} When input validation fails
   * @throws {ScriptReturnError} When return validation fails
   *
   * @example
   * ```ts
   * const result = await myScript.run(redis, {
   *   keys: { key: "test" },
   *   args: { limit: 10 },
   * })
   * ```
   *
   * @since 0.1.0
   */
  run(redis: RedisLike, ...input: ScriptCallArgs<K, A>): Promise<R>
}

/**
 * Base definition for a Lua script.
 *
 * @typeParam K - The keys schema record
 * @typeParam A - The args schema record
 *
 * @since 0.1.0
 */
export interface DefineScriptBase<K extends StringSchemaRecord, A extends StringSchemaRecord> {
  /**
   * Human-readable name for the script.
   * Used in error messages for debugging.
   */
  name: string

  /**
   * The Lua script source code.
   *
   * Keys are available as KEYS[1], KEYS[2], etc.
   * Args are available as ARGV[1], ARGV[2], etc.
   */
  lua: string

  /**
   * Record of key schemas.
   *
   * **Important:** The order of keys in this object determines the order
   * they appear in KEYS[1], KEYS[2], etc. Define keys using object literal
   * syntax in the intended order. Do not spread from unknown sources.
   *
   * Each schema must output a string (use `.transform(String)` if needed).
   */
  keys: K

  /**
   * Record of argument schemas.
   *
   * **Important:** The order of args in this object determines the order
   * they appear in ARGV[1], ARGV[2], etc. Define args using object literal
   * syntax in the intended order. Do not spread from unknown sources.
   *
   * Each schema must output a string (use `.transform(String)` if needed).
   */
  args: A
}

/**
 * Internal input type for script execution.
 */
type ScriptInput<K extends StringSchemaRecord, A extends StringSchemaRecord> = {
  keys?: { [P in keyof K]: StdInput<K[P]> }
  args?: { [P in keyof A]: StdInput<A[P]> }
}

/**
 * Validates and collects keys/args into ordered arrays.
 */
async function validateAndCollect<K extends StringSchemaRecord, A extends StringSchemaRecord>(
  scriptName: string,
  keySchemas: K,
  argSchemas: A,
  keyNames: readonly string[],
  argNames: readonly string[],
  input: ScriptInput<K, A>
): Promise<{ keys: string[]; args: string[] }> {
  const keysArray: string[] = []
  const argsArray: string[] = []

  // Validate and collect keys
  for (const keyName of keyNames) {
    const schema = keySchemas[keyName]
    const value = input.keys?.[keyName]

    const validated = await parseStandard(schema!, value, {
      scriptName,
      path: `keys.${keyName}`,
      type: "input",
    })

    // Runtime check that output is a string
    if (typeof validated !== "string") {
      throw new TypeError(
        `[upstash-lua] Key "${keyName}" schema must output a string, got ${typeof validated}`
      )
    }

    keysArray.push(validated)
  }

  // Validate and collect args
  for (const argName of argNames) {
    const schema = argSchemas[argName]
    const value = input.args?.[argName]

    const validated = await parseStandard(schema!, value, {
      scriptName,
      path: `args.${argName}`,
      type: "input",
    })

    // Runtime check that output is a string
    if (typeof validated !== "string") {
      throw new TypeError(
        `[upstash-lua] Arg "${argName}" schema must output a string, got ${typeof validated}`
      )
    }

    argsArray.push(validated)
  }

  return { keys: keysArray, args: argsArray }
}

/**
 * Defines a type-safe Lua script for execution on Upstash Redis.
 *
 * This function creates a Script object that:
 * - Validates keys and args using StandardSchemaV1 schemas
 * - Transforms values (e.g., numbers to strings for Redis)
 * - Executes efficiently via EVALSHA with automatic NOSCRIPT fallback
 * - Validates and transforms return values
 *
 * **Key ordering:** The order of keys/args in the definition object determines
 * their order in KEYS[1], KEYS[2] and ARGV[1], ARGV[2], etc. Always define
 * using object literal syntax in the intended order.
 *
 * @param def - Script definition with name, lua, keys, args, and optional returns
 * @returns A Script object with `run()` and `runRaw()` methods
 *
 * @example
 * ```ts
 * import { z } from "zod"
 * import { defineScript } from "upstash-lua"
 *
 * const rateLimit = defineScript({
 *   name: "rateLimit",
 *   lua: `
 *     local current = redis.call("INCR", KEYS[1])
 *     if current == 1 then
 *       redis.call("EXPIRE", KEYS[1], ARGV[2])
 *     end
 *     local allowed = current <= tonumber(ARGV[1]) and 1 or 0
 *     return { allowed, tonumber(ARGV[1]) - current }
 *   `,
 *   keys: {
 *     key: z.string(),
 *   },
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
 * @see https://github.com/your-org/upstash-lua for full documentation
 * @since 0.1.0
 */
export function defineScript<
  const K extends StringSchemaRecord,
  const A extends StringSchemaRecord,
  const Ret extends AnyStandardSchema
>(def: DefineScriptBase<K, A> & { returns: Ret }): Script<K, A, StdOutput<Ret>>

/**
 * Defines a Lua script without return validation.
 *
 * When no `returns` schema is provided, `run()` returns `unknown`.
 *
 * @param def - Script definition with name, lua, keys, and args
 * @returns A Script object with `run()` returning `unknown`
 *
 * @since 0.1.0
 */
export function defineScript<
  const K extends StringSchemaRecord,
  const A extends StringSchemaRecord
>(def: DefineScriptBase<K, A> & { returns?: undefined }): Script<K, A, unknown>

/**
 * Implementation of defineScript.
 */
export function defineScript(def: {
  name: string
  lua: string
  keys: Record<string, StandardSchemaV1<unknown, string>>
  args: Record<string, StandardSchemaV1<unknown, string>>
  returns?: StandardSchemaV1<unknown, unknown>
}): Script<StringSchemaRecord, StringSchemaRecord, unknown> {
  const { name, lua, keys: keySchemas, args: argSchemas, returns } = def

  // Extract key and arg names in insertion order
  const keyNames = Object.keys(keySchemas) as string[]
  const argNames = Object.keys(argSchemas) as string[]

  // Lazy SHA1 computation (cached after first run)
  let cachedSha: string | undefined

  async function getSha(): Promise<string> {
    if (cachedSha === undefined) {
      cachedSha = await sha1Hex(lua)
    }
    return cachedSha
  }

  // Core execution logic
  async function execute(
    redis: RedisLike,
    input: ScriptInput<StringSchemaRecord, StringSchemaRecord>
  ): Promise<unknown> {
    const { keys, args } = await validateAndCollect(
      name,
      keySchemas,
      argSchemas,
      keyNames,
      argNames,
      input
    )

    const sha = await getSha()

    return evalWithCache(redis, {
      script: lua,
      sha,
      keys,
      args,
    })
  }

  return {
    name,
    lua,
    keyNames: keyNames as readonly string[],
    argNames: argNames as readonly string[],

    async runRaw(
      redis: RedisLike,
      ...inputArgs: [ScriptInput<StringSchemaRecord, StringSchemaRecord>?]
    ): Promise<unknown> {
      const input = inputArgs[0] ?? {}
      return execute(redis, input)
    },

    async run(
      redis: RedisLike,
      ...inputArgs: [ScriptInput<StringSchemaRecord, StringSchemaRecord>?]
    ): Promise<unknown> {
      const input = inputArgs[0] ?? {}
      const raw = await execute(redis, input)

      // If no returns schema, return raw
      if (!returns) {
        return raw
      }

      // Validate and transform return value
      return parseStandard(returns, raw, {
        scriptName: name,
        path: "return",
        type: "return",
        raw,
      })
    },
  }
}
