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
import {
  type CompiledLua,
  type TokenProxy,
  compileLua,
  createTokenProxy,
  isCompiledLua,
} from "./lua-template.ts"

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
   * @throws {Error} When validation fails
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
 * Function type for type-safe Lua script definition.
 *
 * Receives typed `KEYS` and `ARGV` proxy objects and returns a `CompiledLua`
 * template created with the `lua` tagged template function.
 *
 * @typeParam K - The keys schema record
 * @typeParam A - The args schema record
 *
 * @example
 * ```ts
 * lua: ({ KEYS, ARGV }) => lua`
 *   local key = ${KEYS.userKey}
 *   local limit = tonumber(${ARGV.limit})
 *   return redis.call("GET", key)
 * `
 * ```
 *
 * @since 0.2.0
 */
export type LuaFunction<K extends StringSchemaRecord, A extends StringSchemaRecord> = (ctx: {
  KEYS: TokenProxy<K>
  ARGV: TokenProxy<A>
}) => CompiledLua

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
   * Can be either:
   * - A plain string (for raw `.lua` files or manual scripts)
   * - A function receiving typed `KEYS`/`ARGV` proxies and returning a `lua` template
   *
   * When using the function form, you get:
   * - Autocomplete for `KEYS.*` and `ARGV.*`
   * - Compile-time errors for invalid key/arg references
   * - Automatic compilation of `${KEYS.name}` to `KEYS[n]`
   *
   * @example
   * ```ts
   * // String form (no type safety for KEYS/ARGV):
   * lua: `return redis.call("GET", KEYS[1])`
   *
   * // Function form (type-safe):
   * lua: ({ KEYS, ARGV }) => lua`
   *   local key = ${KEYS.userKey}
   *   return redis.call("GET", key)
   * `
   * ```
   */
  lua: string | LuaFunction<K, A>

  /**
   * Record of key schemas.
   *
   * **Important:** The order of keys in this object determines the order
   * they appear in KEYS[1], KEYS[2], etc. Define keys using object literal
   * syntax in the intended order. Do not spread from unknown sources.
   *
   * Each schema must output a string (use `.transform(String)` if needed).
   */
  keys?: K

  /**
   * Record of argument schemas.
   *
   * **Important:** The order of args in this object determines the order
   * they appear in ARGV[1], ARGV[2], etc. Define args using object literal
   * syntax in the intended order. Do not spread from unknown sources.
   *
   * Each schema must output a string (use `.transform(String)` if needed).
   */
  args?: A
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

  for (const keyName of keyNames) {
    const schema = keySchemas[keyName]
    const value = input.keys?.[keyName]

    const validated = await parseStandard(schema!, value, {
      scriptName,
      path: `keys.${keyName}`,
      type: "input",
    })

    if (typeof validated !== "string") {
      throw new TypeError(
        `[upstash-lua] Key "${keyName}" schema must output a string, got ${typeof validated}`
      )
    }

    keysArray.push(validated)
  }

  for (const argName of argNames) {
    const schema = argSchemas[argName]
    const value = input.args?.[argName]

    const validated = await parseStandard(schema!, value, {
      scriptName,
      path: `args.${argName}`,
      type: "input",
    })

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
 * Resolves the lua property to a string.
 *
 * If `lua` is a string, returns it as-is.
 * If `lua` is a function, creates typed proxies, calls the function,
 * and compiles the result to a Lua string.
 *
 * @internal
 */
function resolveLua(
  luaInput: string | ((ctx: { KEYS: TokenProxy<StringSchemaRecord>; ARGV: TokenProxy<StringSchemaRecord> }) => CompiledLua),
  keyNames: readonly string[],
  argNames: readonly string[]
): string {
  if (typeof luaInput === "string") {
    return luaInput
  }

  const KEYS = createTokenProxy<StringSchemaRecord>("key")
  const ARGV = createTokenProxy<StringSchemaRecord>("arg")

  const compiled = luaInput({ KEYS, ARGV })

  if (!isCompiledLua(compiled)) {
    throw new TypeError(
      `[upstash-lua] lua function must return a lua\`...\` template. ` +
        `Got ${typeof compiled}. Did you forget to use the lua tagged template?`
    )
  }

  return compileLua(compiled, keyNames, argNames)
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
  lua: string | ((ctx: { KEYS: TokenProxy<StringSchemaRecord>; ARGV: TokenProxy<StringSchemaRecord> }) => CompiledLua)
  keys?: Record<string, StandardSchemaV1<unknown, string>>
  args?: Record<string, StandardSchemaV1<unknown, string>>
  returns?: StandardSchemaV1<unknown, unknown>
}): Script<StringSchemaRecord, StringSchemaRecord, unknown> {
  const { name, lua: luaInput, keys: keySchemas = {}, args: argSchemas = {}, returns } = def

  const keyNames = Object.keys(keySchemas)
  const argNames = Object.keys(argSchemas)

  const lua = resolveLua(luaInput, keyNames, argNames)

  let cachedSha: string | undefined

  async function getSha(): Promise<string> {
    if (cachedSha === undefined) {
      cachedSha = await sha1Hex(lua)
    }
    return cachedSha
  }

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

      if (!returns) {
        return raw
      }

      return parseStandard(returns, raw, {
        scriptName: name,
        path: "return",
        type: "return",
        raw,
      })
    },
  }
}
