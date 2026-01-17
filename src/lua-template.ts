/**
 * Type-safe Lua tagged template for defining Redis scripts.
 *
 * This module provides the `lua` tagged template function that enables
 * type-safe `${KEYS.name}` and `${ARGV.name}` interpolations, which are
 * compiled to `KEYS[n]` and `ARGV[n]` at definition time.
 *
 * @example
 * ```ts
 * import { lua, defineScript } from "upstash-lua"
 * import { z } from "zod"
 *
 * const myScript = defineScript({
 *   name: "myScript",
 *   keys: { userKey: z.string() },
 *   args: { limit: z.number().transform(String) },
 *   lua: ({ KEYS, ARGV }) => lua`
 *     local k = ${KEYS.userKey}
 *     local limit = tonumber(${ARGV.limit})
 *     return { k, limit }
 *   `,
 *   returns: z.tuple([z.string(), z.number()]),
 * })
 * ```
 *
 * @module lua-template
 * @since 0.2.0
 */

/**
 * Unique symbol used to brand Lua tokens and compiled templates.
 * This ensures type safety and prevents accidental misuse.
 *
 * @since 0.2.0
 */
export const LUA_TOKEN: unique symbol = Symbol("LUA_TOKEN")

/**
 * A token representing a KEYS or ARGV reference in a Lua template.
 *
 * These tokens are created by accessing properties on the typed
 * `KEYS` and `ARGV` proxy objects passed to the lua function.
 *
 * @example
 * ```ts
 * // KEYS.userKey produces:
 * { [LUA_TOKEN]: true, kind: "key", name: "userKey" }
 *
 * // ARGV.limit produces:
 * { [LUA_TOKEN]: true, kind: "arg", name: "limit" }
 * ```
 *
 * @since 0.2.0
 */
export interface LuaToken {
  readonly [LUA_TOKEN]: true
  readonly kind: "key" | "arg"
  readonly name: string
}

/**
 * The result of the `lua` tagged template function.
 *
 * Contains the template strings and interpolated tokens, which are
 * later compiled into a final Lua string with positional references.
 *
 * @since 0.2.0
 */
export interface CompiledLua {
  readonly [LUA_TOKEN]: "compiled"
  readonly strings: TemplateStringsArray
  readonly tokens: readonly LuaToken[]
}

/**
 * A typed proxy object that produces `LuaToken` values for property access.
 *
 * Used to type `KEYS` and `ARGV` objects passed to the lua function,
 * providing autocomplete and compile-time errors for invalid references.
 *
 * @typeParam T - The schema record type (keys or args)
 *
 * @since 0.2.0
 */
export type TokenProxy<T> = { readonly [P in keyof T]: LuaToken }

/**
 * Type guard to check if a value is a `LuaToken`.
 *
 * @param value - The value to check
 * @returns `true` if the value is a `LuaToken`
 *
 * @since 0.2.0
 */
export function isLuaToken(value: unknown): value is LuaToken {
  return (
    typeof value === "object" &&
    value !== null &&
    LUA_TOKEN in value &&
    (value as LuaToken)[LUA_TOKEN] === true
  )
}

/**
 * Type guard to check if a value is a `CompiledLua` template.
 *
 * @param value - The value to check
 * @returns `true` if the value is a `CompiledLua`
 *
 * @since 0.2.0
 */
export function isCompiledLua(value: unknown): value is CompiledLua {
  return (
    typeof value === "object" &&
    value !== null &&
    LUA_TOKEN in value &&
    (value as CompiledLua)[LUA_TOKEN] === "compiled"
  )
}

/**
 * Creates a typed proxy that produces `LuaToken` values for any property access.
 *
 * @param kind - Whether this proxy is for "key" or "arg" tokens
 * @returns A proxy object that returns tokens for any property access
 *
 * @internal
 * @since 0.2.0
 */
export function createTokenProxy<T extends Record<string, unknown>>(
  kind: "key" | "arg"
): TokenProxy<T> {
  return new Proxy({} as TokenProxy<T>, {
    get(_target, prop): LuaToken {
      if (typeof prop !== "string") {
        throw new TypeError(`[upstash-lua] ${kind.toUpperCase()}S proxy only accepts string keys`)
      }
      return {
        [LUA_TOKEN]: true as const,
        kind,
        name: prop,
      }
    },
  })
}

/**
 * Tagged template function for writing type-safe Lua scripts.
 *
 * Use this with the `KEYS` and `ARGV` proxies provided by `defineScript`
 * to create Lua scripts with type-safe key and argument references.
 *
 * @param strings - Template literal strings
 * @param tokens - Interpolated `LuaToken` values from `KEYS.*` or `ARGV.*`
 * @returns A `CompiledLua` object ready for compilation
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
export function lua(strings: TemplateStringsArray, ...tokens: LuaToken[]): CompiledLua {
  // Validate that all interpolated values are LuaTokens
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!isLuaToken(token)) {
      throw new TypeError(
        `[upstash-lua] lua template only accepts KEYS.* or ARGV.* interpolations. ` +
          `Got ${typeof token} at position ${i + 1}.`
      )
    }
  }

  return {
    [LUA_TOKEN]: "compiled" as const,
    strings,
    tokens,
  }
}

/**
 * Compiles a `CompiledLua` template into a final Lua string.
 *
 * Replaces `KEYS.*` tokens with `KEYS[n]` and `ARGV.*` tokens with `ARGV[n]`
 * based on the order of keys and args in the schema.
 *
 * @param compiled - The compiled lua template from the `lua` tagged template
 * @param keyNames - Ordered list of key names from the schema
 * @param argNames - Ordered list of arg names from the schema
 * @returns The final Lua script string with positional references
 *
 * @throws {Error} If a token references a name not in the schema
 *
 * @example
 * ```ts
 * // Given keyNames = ["userKey"] and argNames = ["limit", "window"]
 * // ${KEYS.userKey} becomes KEYS[1]
 * // ${ARGV.limit} becomes ARGV[1]
 * // ${ARGV.window} becomes ARGV[2]
 * ```
 *
 * @since 0.2.0
 */
export function compileLua(
  compiled: CompiledLua,
  keyNames: readonly string[],
  argNames: readonly string[]
): string {
  const { strings, tokens } = compiled

  // O(1) lookup
  const keyIndexMap = new Map<string, number>()
  for (let i = 0; i < keyNames.length; i++) {
    keyIndexMap.set(keyNames[i]!, i + 1)
  }

  const argIndexMap = new Map<string, number>()
  for (let i = 0; i < argNames.length; i++) {
    argIndexMap.set(argNames[i]!, i + 1)
  }

  let result = strings[0] ?? ""

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    let replacement: string

    if (token.kind === "key") {
      const index = keyIndexMap.get(token.name)
      if (index === undefined) {
        throw new Error(
          `[upstash-lua] Unknown key "${token.name}" in lua template. ` +
            `Available keys: ${keyNames.length > 0 ? keyNames.join(", ") : "(none)"}`
        )
      }
      replacement = `KEYS[${index}]`
    } else {
      const index = argIndexMap.get(token.name)
      if (index === undefined) {
        throw new Error(
          `[upstash-lua] Unknown arg "${token.name}" in lua template. ` +
            `Available args: ${argNames.length > 0 ? argNames.join(", ") : "(none)"}`
        )
      }
      replacement = `ARGV[${index}]`
    }

    result += replacement + (strings[i + 1] ?? "")
  }

  return result
}
