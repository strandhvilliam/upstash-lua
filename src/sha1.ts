/**
 * Computes the SHA1 hash of a string and returns it as a hexadecimal string.
 *
 * This implementation uses the WebCrypto API, which is available in:
 * - Node.js 18+ (via `globalThis.crypto.subtle`)
 * - Bun (full WebCrypto support)
 * - Cloudflare Workers
 * - Vercel Edge Runtime
 * - Deno
 *
 * The SHA1 hash is used by Redis to identify cached Lua scripts for
 * efficient execution via EVALSHA.
 *
 * @param text - The string to hash (typically a Lua script)
 * @returns Promise resolving to the 40-character lowercase hexadecimal SHA1 hash
 *
 * @example
 * ```ts
 * const hash = await sha1Hex('return redis.call("PING")')
 * console.log(hash) // "e.g., a42059b356c875f0717db19a51f6aaa9161e77a2"
 * ```
 *
 * @throws {Error} If WebCrypto is not available in the runtime
 *
 * @since 0.1.0
 */
export async function sha1Hex(text: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error(
      "[upstash-lua] WebCrypto (crypto.subtle) is not available. " +
        "This library requires Node.js 18+, Bun, or an Edge runtime."
    )
  }

  const encoder = new TextEncoder()
  const data = encoder.encode(text)
  const hashBuffer = await crypto.subtle.digest("SHA-1", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}
