# upstash-lua

Type-safe Lua scripts for Upstash Redis with StandardSchemaV1 validation.

## Features

- **Full TypeScript inference** for keys, args, and return values
- **Type-safe Lua templates** - Use `${KEYS.name}` and `${ARGV.name}` with autocomplete and compile-time errors
- **Input validation** using StandardSchemaV1 schemas (Zod, Effect Schema, ArkType, etc.)
- **Efficient execution** via EVALSHA with automatic NOSCRIPT fallback
- **Universal runtime support** - Node.js 18+, Bun, Cloudflare Workers, Vercel Edge

## Installation

```bash
bun add upstash-lua @upstash/redis zod
# or
npm install upstash-lua @upstash/redis zod
```

## Quick Start

```typescript
import { z } from "zod"
import { defineScript, lua } from "upstash-lua"
import { Redis } from "@upstash/redis"

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

// Define a rate limiter script with type-safe Lua template
const rateLimit = defineScript({
  name: "rateLimit",
  keys: {
    key: z.string(),
  },
  args: {
    limit: z.number().int().positive().transform(String),
    windowSeconds: z.number().int().positive().transform(String),
  },
  lua: ({ KEYS, ARGV }) => lua`
    local current = redis.call("INCR", ${KEYS.key})
    if current == 1 then
      redis.call("EXPIRE", ${KEYS.key}, ${ARGV.windowSeconds})
    end
    local allowed = current <= tonumber(${ARGV.limit}) and 1 or 0
    return { allowed, tonumber(${ARGV.limit}) - current }
  `,
  returns: z.tuple([z.number(), z.number()]).transform(([allowed, rem]) => ({
    allowed: allowed === 1,
    remaining: rem,
  })),
})

// Execute with full type safety
const result = await rateLimit.run(redis, {
  keys: { key: "rl:user:123" },
  args: { limit: 10, windowSeconds: 60 },
})

console.log(result.allowed)   // boolean
console.log(result.remaining) // number
```

## API

### `defineScript(options)`

Creates a type-safe Lua script definition.

#### Options

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Human-readable name (used in error messages) |
| `lua` | `string \| LuaFunction` | Lua script source code (string) or type-safe template function |
| `keys` | `Record<string, Schema>` | Key schemas - order determines KEYS[1], KEYS[2], etc. |
| `args` | `Record<string, Schema>` | Arg schemas - order determines ARGV[1], ARGV[2], etc. |
| `returns` | `Schema` | Optional return value schema |

**Important:** Key/arg order is determined by object literal insertion order. Always define using object literal syntax in the intended order.

#### Lua Property: String vs Function

The `lua` property can be either a plain string or a function that returns a `lua` template:

**String form** (manual KEYS/ARGV indexing):
```typescript
lua: `return redis.call("GET", KEYS[1])`
```

**Function form** (type-safe with autocomplete):
```typescript
lua: ({ KEYS, ARGV }) => lua`
  return redis.call("GET", ${KEYS.userKey})
`
```

The function form provides:
- ✅ Autocomplete for `KEYS.*` and `ARGV.*` properties
- ✅ Compile-time errors for invalid key/arg references
- ✅ Automatic compilation of `${KEYS.name}` → `KEYS[n]` and `${ARGV.name}` → `ARGV[n]`

#### Returns

A `Script` object with:

- `run(redis, input)` - Execute with full validation
- `runRaw(redis, input)` - Execute without return validation
- `name`, `lua`, `keyNames`, `argNames` - Metadata

### Schema Requirements

Keys and args must output strings (Redis only accepts strings). Use transforms:

```typescript
args: {
  // Number input → string output
  limit: z.number().transform(String),
  
  // Boolean input → "1" or "0" output
  enabled: z.boolean().transform(b => b ? "1" : "0"),
  
  // String input → string output (no transform needed)
  key: z.string(),
}
```

## Examples

### Type-Safe Lua Template

Use the `lua` tagged template function for type-safe key and argument references:

```typescript
import { defineScript, lua } from "upstash-lua"
import { z } from "zod"

const getUser = defineScript({
  name: "getUser",
  keys: {
    userKey: z.string(),
  },
  args: {
    field: z.string(),
  },
  lua: ({ KEYS, ARGV }) => lua`
    -- TypeScript autocomplete works here!
    local key = ${KEYS.userKey}
    local field = ${ARGV.field}
    return redis.call("HGET", key, field)
  `,
  returns: z.string().nullable(),
})

// ${KEYS.userKey} automatically becomes KEYS[1]
// ${ARGV.field} automatically becomes ARGV[1]
```

### Simple Script (No Keys/Args)

```typescript
const ping = defineScript({
  name: "ping",
  lua: 'return redis.call("PING")',
  returns: z.string(),
})

const result = await ping.run(redis)
// result: "PONG"
```

Or with the function form:

```typescript
const ping = defineScript({
  name: "ping",
  lua: () => lua`return redis.call("PING")`,
  returns: z.string(),
})
```

### Script Without Return Validation

```typescript
const getData = defineScript({
  name: "getData",
  lua: 'return redis.call("HGETALL", KEYS[1])',
  keys: { key: z.string() },
  // No returns schema - result is unknown
})

const result = await getData.run(redis, { keys: { key: "user:123" } })
// result: unknown
```

### Effect Schema Example

```typescript
import { Schema } from "effect"
import { defineScript, lua } from "upstash-lua"

const incr = defineScript({
  name: "incr",
  keys: {
    key: Schema.standardSchemaV1(Schema.String),
  },
  args: {
    amount: Schema.standardSchemaV1(
      Schema.Number.pipe(
        Schema.transform(Schema.String, (n) => String(n), (s) => Number(s))
      )
    ),
  },
  lua: ({ KEYS, ARGV }) => lua`
    return redis.call("INCRBY", ${KEYS.key}, ${ARGV.amount})
  `,
  returns: Schema.standardSchemaV1(Schema.Number),
})
```

## Error Handling

Errors are thrown as `Error` objects with descriptive messages when validation fails:

```typescript
try {
  await script.run(redis, { args: { limit: -1 } })
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message)
    // "[upstash-lua@0.2.0] Script \"rateLimit\" input validation failed at \"args.limit\": Number must be positive"
  }
}
```

Error messages include:
- The library version
- The script name
- The validation path (for input errors)
- The validation error messages

## How It Works

1. **Define** - Creates script with metadata and computed SHA1
   - If `lua` is a function, it's called with typed `KEYS`/`ARGV` proxies
   - The `lua` template is compiled: `${KEYS.name}` → `KEYS[n]`, `${ARGV.name}` → `ARGV[n]`
2. **Validate** - Keys/args are validated against StandardSchemaV1 schemas
3. **Transform** - Validated values are transformed (e.g., numbers → strings)
4. **Execute** - Uses EVALSHA for efficiency, falls back to SCRIPT LOAD on NOSCRIPT
5. **Parse** - Return value is validated/transformed if schema provided

The library caches script loading per-client, so concurrent calls share a single SCRIPT LOAD.

## Versioning

```typescript
import { VERSION } from "upstash-lua"
console.log(`Using upstash-lua v${VERSION}`)
```

Errors include the version for debugging:
```
[upstash-lua@0.1.0] Script "rateLimit" input validation failed at "args.limit": ...
```

## License

MIT
