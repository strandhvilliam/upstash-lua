import type { StandardSchemaV1 } from "@standard-schema/spec"

/**
 * Represents any StandardSchemaV1 schema with arbitrary input and output types.
 *
 * @since 0.1.0
 */
export type AnyStandardSchema = StandardSchemaV1<unknown, unknown>

/**
 * Extracts the input type from a StandardSchemaV1 schema.
 *
 * @typeParam S - The StandardSchemaV1 schema type
 * @returns The input type that the schema accepts for validation
 *
 * @example
 * ```ts
 * // With Zod:
 * type Input = StdInput<typeof z.string()> // string
 * type Input2 = StdInput<typeof z.number().transform(String)> // number
 * ```
 *
 * @since 0.1.0
 */
export type StdInput<S extends AnyStandardSchema> = S extends StandardSchemaV1<infer I, unknown>
  ? I
  : never

/**
 * Extracts the output type from a StandardSchemaV1 schema.
 *
 * @typeParam S - The StandardSchemaV1 schema type
 * @returns The output type after validation and transformation
 *
 * @example
 * ```ts
 * // With Zod:
 * type Output = StdOutput<typeof z.string()> // string
 * type Output2 = StdOutput<typeof z.number().transform(String)> // string
 * ```
 *
 * @since 0.1.0
 */
export type StdOutput<S extends AnyStandardSchema> = S extends StandardSchemaV1<unknown, infer O>
  ? O
  : never

/**
 * A StandardSchemaV1 schema that outputs a string.
 * Used for keys and args which must be strings when sent to Redis.
 *
 * @since 0.1.0
 */
export type StringOutSchema = StandardSchemaV1<unknown, string>

/**
 * A record of named schemas that all output strings.
 * Used for defining keys and args in script definitions.
 *
 * @since 0.1.0
 */
export type StringSchemaRecord = Record<string, StringOutSchema>

/**
 * Maps a record of schemas to their input types.
 *
 * @typeParam T - Record of StandardSchemaV1 schemas
 * @returns Object type with same keys but input types as values
 *
 * @example
 * ```ts
 * type Inputs = InputsOf<{
 *   key: typeof z.string(),
 *   limit: typeof z.number().transform(String)
 * }>
 * // { key: string; limit: number }
 * ```
 *
 * @since 0.1.0
 */
export type InputsOf<T extends Record<string, AnyStandardSchema>> = {
  [K in keyof T]: StdInput<T[K]>
}

/**
 * Maps a record of schemas to their output types.
 *
 * @typeParam T - Record of StandardSchemaV1 schemas
 * @returns Object type with same keys but output types as values
 *
 * @since 0.1.0
 */
export type OutputsOf<T extends Record<string, AnyStandardSchema>> = {
  [K in keyof T]: StdOutput<T[K]>
}

/**
 * Computes the input payload shape required by `run()`, depending on whether
 * keys and/or args are defined (non-empty records).
 *
 * - If both are empty: `{}`
 * - If only keys defined: `{ keys: ... }`
 * - If only args defined: `{ args: ... }`
 * - If both defined: `{ keys: ..., args: ... }`
 *
 * @typeParam K - The keys schema record
 * @typeParam A - The args schema record
 *
 * @since 0.1.0
 */
export type ScriptCallInput<
  K extends StringSchemaRecord,
  A extends StringSchemaRecord
> = (keyof K extends never ? object : { keys: InputsOf<K> }) &
  (keyof A extends never ? object : { args: InputsOf<A> })

/**
 * Rest-parameter tuple type for `run()` method.
 *
 * - When no keys and no args: `[]` (no second argument)
 * - Otherwise: `[input: ScriptCallInput<K, A>]`
 *
 * This enables clean call signatures:
 * - `run(redis)` when keys and args are both empty
 * - `run(redis, { keys, args })` otherwise
 *
 * @typeParam K - The keys schema record
 * @typeParam A - The args schema record
 *
 * @since 0.1.0
 */
export type ScriptCallArgs<
  K extends StringSchemaRecord,
  A extends StringSchemaRecord
> = keyof ScriptCallInput<K, A> extends never ? [] : [input: ScriptCallInput<K, A>]
