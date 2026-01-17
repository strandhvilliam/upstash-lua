import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { hashResult } from "../src/hash-result.ts"
import { validateStandard } from "../src/standard-schema.ts"

describe("hashResult", () => {
  describe("basic conversion", () => {
    test("converts flat array to object and validates", async () => {
      const schema = hashResult(z.object({
        name: z.string(),
        email: z.string(),
      }))

      const result = await validateStandard(schema, ["name", "Alice", "email", "alice@example.com"])

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toEqual({
          name: "Alice",
          email: "alice@example.com",
        })
      }
    })

    test("handles empty array", async () => {
      const schema = hashResult(z.object({}).passthrough())

      const result = await validateStandard(schema, [])

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toEqual({})
      }
    })

    test("preserves field order from array", async () => {
      const schema = hashResult(z.object({
        a: z.string(),
        b: z.string(),
        c: z.string(),
      }))

      const result = await validateStandard(schema, ["c", "3", "a", "1", "b", "2"])

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toEqual({ a: "1", b: "2", c: "3" })
      }
    })
  })

  describe("with transforms", () => {
    test("applies schema transforms after conversion", async () => {
      const schema = hashResult(z.object({
        name: z.string(),
        age: z.coerce.number(),
        active: z.string().transform(v => v === "1"),
      }))

      const result = await validateStandard(schema, [
        "name", "Bob",
        "age", "30",
        "active", "1",
      ])

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toEqual({
          name: "Bob",
          age: 30,
          active: true,
        })
      }
    })

    test("works with z.coerce for numeric values", async () => {
      const schema = hashResult(z.object({
        count: z.coerce.number(),
        score: z.coerce.number(),
      }))

      const result = await validateStandard(schema, ["count", "42", "score", "99.5"])

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toEqual({ count: 42, score: 99.5 })
      }
    })
  })

  describe("with optional/partial fields", () => {
    test("handles optional fields", async () => {
      const schema = hashResult(z.object({
        name: z.string(),
        email: z.string().optional(),
      }))

      const result = await validateStandard(schema, ["name", "Charlie"])

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toEqual({ name: "Charlie" })
      }
    })

    test("handles partial objects", async () => {
      const schema = hashResult(z.object({
        name: z.string(),
        email: z.string(),
        age: z.coerce.number(),
      }).partial())

      const result = await validateStandard(schema, ["name", "Dave"])

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toEqual({ name: "Dave" })
      }
    })
  })

  describe("with passthrough/strict", () => {
    test("passthrough allows extra fields", async () => {
      const schema = hashResult(z.object({
        name: z.string(),
      }).passthrough())

      const result = await validateStandard(schema, [
        "name", "Eve",
        "extra", "field",
      ])

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toEqual({ name: "Eve", extra: "field" })
      }
    })

    test("strict rejects extra fields", async () => {
      const schema = hashResult(z.object({
        name: z.string(),
      }).strict())

      const result = await validateStandard(schema, [
        "name", "Frank",
        "extra", "field",
      ])

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.issues.length).toBeGreaterThan(0)
      }
    })
  })

  describe("error handling", () => {
    test("returns error for non-array input", async () => {
      const schema = hashResult(z.object({ name: z.string() }))

      const result = await validateStandard(schema, "not an array" as unknown as unknown[])

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.issues[0]?.message).toContain("Expected array")
      }
    })

    test("returns error for odd-length array", async () => {
      const schema = hashResult(z.object({ name: z.string() }))

      const result = await validateStandard(schema, ["name", "value", "orphan"])

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.issues[0]?.message).toContain("even number")
      }
    })

    test("returns error for non-string keys", async () => {
      const schema = hashResult(z.object({ name: z.string() }))

      const result = await validateStandard(schema, [123, "value"] as unknown as unknown[])

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.issues[0]?.message).toContain("string key")
      }
    })

    test("returns validation error for invalid field value", async () => {
      const schema = hashResult(z.object({
        name: z.string(),
        age: z.number(),
      }))

      const result = await validateStandard(schema, ["name", "Grace", "age", "not a number"])

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.issues.length).toBeGreaterThan(0)
      }
    })

    test("returns validation error for missing required field", async () => {
      const schema = hashResult(z.object({
        name: z.string(),
        email: z.string(),
      }))

      const result = await validateStandard(schema, ["name", "Henry"])

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.issues.length).toBeGreaterThan(0)
      }
    })
  })

  describe("StandardSchemaV1 compliance", () => {
    test("has correct ~standard properties", () => {
      const schema = hashResult(z.object({ name: z.string() }))

      expect(schema["~standard"].version).toBe(1)
      expect(schema["~standard"].vendor).toBe("upstash-lua")
      expect(typeof schema["~standard"].validate).toBe("function")
    })

    test("validate returns value on success", () => {
      const schema = hashResult(z.object({ name: z.string() }))

      const result = schema["~standard"].validate(["name", "Test"])

      expect("value" in result).toBe(true)
      if ("value" in result) {
        expect(result.value).toEqual({ name: "Test" })
      }
    })

    test("validate returns issues on failure", () => {
      const schema = hashResult(z.object({ name: z.string() }))

      const result = schema["~standard"].validate("invalid")

      expect("issues" in result).toBe(true)
      if ("issues" in result) {
        expect(result.issues?.length).toBeGreaterThan(0)
      }
    })
  })

  describe("real-world HGETALL scenarios", () => {
    test("user profile from HGETALL", async () => {
      const userSchema = hashResult(z.object({
        id: z.string(),
        username: z.string(),
        email: z.string(),
        created_at: z.string(),
        login_count: z.coerce.number(),
        is_admin: z.string().transform(v => v === "true"),
      }))

      const hgetallResponse = [
        "id", "user:123",
        "username", "johndoe",
        "email", "john@example.com",
        "created_at", "2024-01-15T10:30:00Z",
        "login_count", "42",
        "is_admin", "false",
      ]

      const result = await validateStandard(userSchema, hgetallResponse)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toEqual({
          id: "user:123",
          username: "johndoe",
          email: "john@example.com",
          created_at: "2024-01-15T10:30:00Z",
          login_count: 42,
          is_admin: false,
        })
      }
    })

    test("session data with nullable fields", async () => {
      const sessionSchema = hashResult(z.object({
        user_id: z.string(),
        token: z.string(),
        expires_at: z.string(),
        ip_address: z.string().optional(),
      }))

      const result = await validateStandard(sessionSchema, [
        "user_id", "u:456",
        "token", "abc123",
        "expires_at", "2024-12-31",
      ])

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.user_id).toBe("u:456")
        expect(result.value.ip_address).toBeUndefined()
      }
    })
  })
})
