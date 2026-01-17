import type { StandardSchemaV1 } from "@standard-schema/spec"
import { VERSION } from "./version.ts"


/**
 * Represents a validation issue from a StandardSchemaV1 schema.
 * This is a simplified representation that works across different schema libraries.
 *
 * @since 0.1.0
 */
export interface ValidationIssue {
  /** Human-readable error message */
  readonly message: string
  /** Path to the invalid value within the input */
  readonly path?: ReadonlyArray<PropertyKey>
}

/**
 * Result of a successful validation.
 *
 * @since 0.1.0
 */
export interface ValidationSuccess<T> {
  readonly ok: true
  readonly value: T
}

/**
 * Result of a failed validation.
 *
 * @since 0.1.0
 */
export interface ValidationFailure {
  readonly ok: false
  readonly issues: readonly ValidationIssue[]
}

/**
 * Result of validating a value against a StandardSchemaV1 schema.
 *
 * @since 0.1.0
 */
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure

/**
 * Validates a value against a StandardSchemaV1 schema.
 *
 * This function handles both synchronous and asynchronous validation,
 * as StandardSchemaV1 allows either. It returns a discriminated union
 * for easy handling of success/failure cases.
 *
 * @param schema - The StandardSchemaV1 schema to validate against
 * @param value - The value to validate
 * @returns A promise resolving to either `{ ok: true, value }` or `{ ok: false, issues }`
 *
 * @example
 * ```ts
 * import { z } from "zod"
 *
 * const result = await validateStandard(z.string(), "hello")
 * if (result.ok) {
 *   console.log(result.value) // "hello"
 * } else {
 *   console.error(result.issues)
 * }
 * ```
 *
 * @since 0.1.0
 */
export async function validateStandard<I, O>(
  schema: StandardSchemaV1<I, O>,
  value: I
): Promise<ValidationResult<O>> {
  const result = schema["~standard"].validate(value)

  // Handle async validation (returns a Promise)
  const resolved = result instanceof Promise ? await result : result

  if ("issues" in resolved && resolved.issues) {
    return {
      ok: false,
      issues: resolved.issues.map((issue) => ({
        message: issue.message,
        path: issue.path?.map((p) =>
          typeof p === "object" && p !== null && "key" in p ? p.key : p
        ),
      })),
    }
  }

  return {
    ok: true,
    value: resolved.value as O,
  }
}

/**
 * Context for parsing operations, used to generate meaningful error messages.
 *
 * @since 0.1.0
 */
export interface ParseContext {
  /** Name of the script being executed */
  readonly scriptName: string
  /** Path to the field being validated (e.g., "keys.userId" or "args.limit") */
  readonly path: string
  /** Type of value being parsed: "input" for keys/args, "return" for script response */
  readonly type: "input" | "return"
  /** Raw value (only for return validation, used in error reporting) */
  readonly raw?: unknown
}

/**
 * Validates a value and throws a descriptive error on failure.
 *
 * This is a convenience wrapper around `validateStandard` that throws
 * appropriate error types based on the context.
 *
 * @param schema - The StandardSchemaV1 schema to validate against
 * @param value - The value to validate
 * @param context - Context for error messages
 * @returns The validated and potentially transformed value
 * @throws {Error} When validation fails
 *
 * @example
 * ```ts
 * // For input validation:
 * const validated = await parseStandard(schema, input, {
 *   scriptName: "myScript",
 *   path: "args.limit",
 *   type: "input"
 * })
 *
 * // For return validation:
 * const result = await parseStandard(schema, rawResult, {
 *   scriptName: "myScript",
 *   path: "return",
 *   type: "return",
 *   raw: rawResult
 * })
 * ```
 *
 * @since 0.1.0
 */
export async function parseStandard<I, O>(
  schema: StandardSchemaV1<I, O>,
  value: I,
  context: ParseContext
): Promise<O> {
  const result = await validateStandard(schema, value)

  if (!result.ok) {
    if (context.type === "input") {
      const issueMessages = result.issues.map((i) => i.message).join(", ")
      throw new Error(
        `[upstash-lua@${VERSION}] Script "${context.scriptName}" input validation failed at "${context.path}": ${issueMessages}`
      )
    } else {
      const issueMessages = result.issues.map((i) => i.message).join(", ")
      throw new Error(
        `[upstash-lua@${VERSION}] Script "${context.scriptName}" return validation failed: ${issueMessages}`
      )
    }
  }

  return result.value
}
