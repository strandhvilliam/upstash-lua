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
 * Error thrown when script input validation fails.
 *
 * This error is thrown when keys or args fail to validate against their
 * respective StandardSchemaV1 schemas before the script is executed.
 *
 * @example
 * ```ts
 * try {
 *   await myScript.run(redis, { keys: { key: "" }, args: { limit: -1 } })
 * } catch (error) {
 *   if (error instanceof ScriptInputError) {
 *     console.error(`Script: ${error.scriptName}`)
 *     console.error(`Field: ${error.path}`)  // e.g., "args.limit"
 *     console.error(`Issues:`, error.issues)
 *   }
 * }
 * ```
 *
 * @since 0.1.0
 */
export class ScriptInputError extends Error {
  /**
   * The name of the script that failed validation.
   * Matches the `name` property in the script definition.
   */
  readonly scriptName: string

  /**
   * The path to the invalid field.
   * Format: `"keys.<fieldName>"` or `"args.<fieldName>"`
   *
   * @example "args.limit", "keys.userId"
   */
  readonly path: string

  /**
   * Array of validation issues from the schema library.
   * Each issue contains at least a `message` property.
   */
  readonly issues: readonly ValidationIssue[]

  /**
   * Creates a new ScriptInputError.
   *
   * @param scriptName - Name of the script that failed validation
   * @param path - Path to the invalid field (e.g., "args.limit")
   * @param issues - Array of validation issues from the schema
   */
  constructor(scriptName: string, path: string, issues: readonly ValidationIssue[]) {
    const issueMessages = issues.map((i) => i.message).join(", ")
    super(
      `[upstash-lua@${VERSION}] Script "${scriptName}" input validation failed at "${path}": ${issueMessages}`
    )

    this.name = "ScriptInputError"
    this.scriptName = scriptName
    this.path = path
    this.issues = issues

    // Maintains proper stack trace in V8 environments (Node, Chrome, etc.)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ScriptInputError)
    }
  }
}

/**
 * Error thrown when script return value validation fails.
 *
 * This error is thrown when the Redis response fails to validate against
 * the `returns` StandardSchemaV1 schema after script execution.
 *
 * @example
 * ```ts
 * try {
 *   await myScript.run(redis, { keys: { key: "test" } })
 * } catch (error) {
 *   if (error instanceof ScriptReturnError) {
 *     console.error(`Script: ${error.scriptName}`)
 *     console.error(`Raw response:`, error.raw)
 *     console.error(`Issues:`, error.issues)
 *   }
 * }
 * ```
 *
 * @since 0.1.0
 */
export class ScriptReturnError extends Error {
  /**
   * The name of the script whose return validation failed.
   * Matches the `name` property in the script definition.
   */
  readonly scriptName: string

  /**
   * Array of validation issues from the schema library.
   * Each issue contains at least a `message` property.
   */
  readonly issues: readonly ValidationIssue[]

  /**
   * The raw value returned from Redis before validation.
   * Useful for debugging schema mismatches.
   */
  readonly raw: unknown

  /**
   * Creates a new ScriptReturnError.
   *
   * @param scriptName - Name of the script that failed validation
   * @param issues - Array of validation issues from the schema
   * @param raw - The raw Redis response that failed validation
   */
  constructor(scriptName: string, issues: readonly ValidationIssue[], raw: unknown) {
    const issueMessages = issues.map((i) => i.message).join(", ")
    super(
      `[upstash-lua@${VERSION}] Script "${scriptName}" return validation failed: ${issueMessages}`
    )

    this.name = "ScriptReturnError"
    this.scriptName = scriptName
    this.issues = issues
    this.raw = raw

    // Maintains proper stack trace in V8 environments (Node, Chrome, etc.)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ScriptReturnError)
    }
  }
}
