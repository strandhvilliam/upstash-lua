import { describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  validateStandard,
  parseStandard,
} from "../src/standard-schema.ts"

describe("validateStandard", () => {
  test("returns ok: true with validated value for valid input", async () => {
    const schema = z.string()
    const result = await validateStandard(schema, "hello")

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe("hello")
    }
  })

  test("returns ok: true with transformed value", async () => {
    const schema = z.number().transform(String)
    const result = await validateStandard(schema, 42)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe("42")
    }
  })

  test("returns ok: false with issues for invalid input", async () => {
    const schema = z.string()
    const result = await validateStandard(schema, 123 as unknown as string)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0)
      expect(result.issues[0]?.message).toBeDefined()
    }
  })

  test("returns ok: false for failed refinement", async () => {
    const schema = z.number().positive()
    const result = await validateStandard(schema, -5)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0)
    }
  })

  test("handles complex object validation", async () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().positive(),
    })

    const validResult = await validateStandard(schema, { name: "Alice", age: 30 })
    expect(validResult.ok).toBe(true)

    const invalidResult = await validateStandard(schema, { name: "Bob", age: -5 })
    expect(invalidResult.ok).toBe(false)
  })
})

describe("parseStandard", () => {
  test("returns validated value for valid input", async () => {
    const schema = z.string()
    const value = await parseStandard(schema, "hello", {
      scriptName: "testScript",
      path: "args.value",
      type: "input",
    })

    expect(value).toBe("hello")
  })

  test("returns transformed value", async () => {
    const schema = z.number().int().positive().transform(String)
    const value = await parseStandard(schema, 42, {
      scriptName: "testScript",
      path: "args.limit",
      type: "input",
    })

    expect(value).toBe("42")
  })

  test("throws Error for invalid input", async () => {
    const schema = z.number().positive()

    try {
      await parseStandard(schema, -1, {
        scriptName: "rateLimit",
        path: "args.limit",
        type: "input",
      })
      expect(true).toBe(false) // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      if (error instanceof Error) {
        expect(error.message).toContain("rateLimit")
        expect(error.message).toContain("args.limit")
        expect(error.message).toContain("upstash-lua@")
        expect(error.message).toContain("input validation failed")
      }
    }
  })

  test("throws Error for invalid return value", async () => {
    const schema = z.number()
    const rawValue = "not a number"

    try {
      await parseStandard(schema, rawValue as unknown as number, {
        scriptName: "increment",
        path: "return",
        type: "return",
        raw: rawValue,
      })
      expect(true).toBe(false) // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      if (error instanceof Error) {
        expect(error.message).toContain("increment")
        expect(error.message).toContain("upstash-lua@")
        expect(error.message).toContain("return validation failed")
      }
    }
  })

  test("error messages include version", async () => {
    const schema = z.string()

    try {
      await parseStandard(schema, 123 as unknown as string, {
        scriptName: "testScript",
        path: "keys.id",
        type: "input",
      })
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      if (error instanceof Error) {
        expect(error.message).toMatch(/\[upstash-lua@\d+\.\d+\.\d+\]/)
      }
    }
  })
})
