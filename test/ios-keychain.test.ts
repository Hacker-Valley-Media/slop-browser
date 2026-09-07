import { describe, expect, test } from "bun:test"
import { storeToken, loadToken, deleteToken, hasToken } from "../daemon/ios/keychain"
import { HAS_SECURITY } from "./helpers/macos-tools"

// Roundtrips the Apple-ID token through the REAL login keychain under a throwaway
// service name, then deletes it. Verifies the trust boundary: the token
// lives in the Keychain (via Bun.secrets since issue #244, never on argv), never in
// state.json.

// Every case here drives the REAL login keychain through /usr/bin/security.
describe.skipIf(!HAS_SECURITY)("keychain token store", () => {
  // Unique per-run-ish service so a crashed prior run can't collide. No Date.now
  // in the value — just a fixed test service we always clean up.
  const ref = { service: "com.interceptor.ios.appleid.test", account: "roundtrip" }

  test("store → load → delete roundtrip", async () => {
    // Clean any leftover first so the assertion is deterministic.
    await deleteToken(ref)
    expect(await hasToken(ref)).toBe(false)

    const token = "sess_token.ABC123-with/slashes+and=equals and spaces"
    const stored = await storeToken(token, ref)
    expect(stored.ok).toBe(true)

    expect(await loadToken(ref)).toBe(token)
    expect(await hasToken(ref)).toBe(true)

    // A second set replaces in place.
    expect((await storeToken("second-value", ref)).ok).toBe(true)
    expect(await loadToken(ref)).toBe("second-value")

    expect((await deleteToken(ref)).ok).toBe(true)
    expect(await loadToken(ref)).toBeUndefined()
  })

  test("delete of an absent item is not an error", async () => {
    expect((await deleteToken({ service: "com.interceptor.ios.appleid.test", account: "never-existed" })).ok).toBe(true)
  })
})
