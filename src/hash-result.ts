import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { AnyStandardSchema, StdOutput } from "./types.ts"

/**
 * Converts a flat array of alternating key-value pairs to an object.
 *
 * Redis commands like HGETALL return data in this format:
 * `["field1", "value1", "field2", "value2"]` → `{ field1: "value1", field2: "value2" }`
 *
 * @param arr - The flat array of key-value pairs
 * @returns An object with the key-value pairs
 * @throws {Error} If the input is not an array or has an odd length
 *
 * @internal
 */
function pairsToObject(arr: unknown): Record<string, unknown> {
  if (!Array.isArray(arr)) {
    throw new Error(
      `Expected array of key-value pairs, got ${typeof arr}`
    )
  }

  if (arr.length % 2 !== 0) {
    throw new Error(
      `Expected even number of elements (key-value pairs), got ${arr.length}`
    )
  }

  const result: Record<string, unknown> = {}

  for (let i = 0; i < arr.length; i += 2) {
    const key = arr[i]
    const value = arr[i + 1]

    if (typeof key !== "string") {
      throw new Error(
        `Expected string key at index ${i}, got ${typeof key}`
      )
    }

    result[key] = value
  }

  return result
}

/**
 * Wraps a StandardSchemaV1 object schema to accept HGETALL-style array input.
 *
 * Redis commands like `HGETALL` return flat arrays of alternating key-value pairs:
 * `["field1", "value1", "field2", "value2"]`
 *
 * This helper converts that format to an object before validating with your schema,
 * enabling a much cleaner DX:
 *
 * @typeParam S - The inner schema type (must accept object input)
 * @param schema - A StandardSchemaV1 schema that validates objects
 * @returns A new schema that accepts `unknown[]` and outputs the validated type
 *
 * @example
 * ```ts
 * import { z } from "zod"
 * import { defineScript, hashResult } from "upstash-lua"
 *
 * const getUser = defineScript({
 *   name: "getUser",
 *   lua: `return redis.call("HGETALL", KEYS[1])`,
 *   keys: { key: z.string() },
 *   returns: hashResult(z.object({
 *     name: z.string(),
 *     email: z.string(),
 *     age: z.coerce.number(),
 *   })),
 * })
 *
 * // Result is typed as { name: string, email: string, age: number }
 * const user = await getUser.run(redis, { keys: { key: "user:123" } })
 * ```
 *
 * @example
 * ```ts
 * // Works with partial/optional fields too
 * returns: hashResult(z.object({
 *   name: z.string(),
 *   email: z.string().optional(),
 * }).partial())
 * ```
 *
 * @since 0.3.0
 */
export function hashResult<S extends AnyStandardSchema>(
  schema: S
): StandardSchemaV1<unknown[], StdOutput<S>> {
  return {
    "~standard": {
      version: 1,
      vendor: "upstash-lua",
      validate(value: unknown): 
        | { value: StdOutput<S> }
        | { issues: StandardSchemaV1.Issue[] } {
        let obj: Record<string, unknown>
        try {
          obj = pairsToObject(value)
        } catch (error) {
          return {
            issues: [{
              message: error instanceof Error ? error.message : String(error),
            }],
          }
        }

        const result = schema["~standard"].validate(obj)

        // for StandardSchemaV1 compliance
        if (result instanceof Promise) {
          return result as Promise<
            | { value: StdOutput<S> }
            | { issues: StandardSchemaV1.Issue[] }
          > as unknown as { value: StdOutput<S> } | { issues: StandardSchemaV1.Issue[] }
        }

        return result as { value: StdOutput<S> } | { issues: StandardSchemaV1.Issue[] }
      },
    },
  }
}
