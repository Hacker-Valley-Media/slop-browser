/**
 * test/process-liveness.test.ts
 *
 * isProcessAlive must not count a zombie as running.
 *
 * The daemon is spawned detached and reparented to PID 1. On Linux that PID 1 is
 * frequently not an init that reaps (a container started without --init, most CI
 * images, many Kubernetes pods), so an exited daemon lingers as a zombie and keeps
 * answering `kill(pid, 0)`. `interceptor daemon stop` then waits out its full
 * timeout and exits non-zero on a daemon it successfully stopped, and a stale pid
 * file makes `status` report a daemon nothing can reach.
 *
 * The /proc parsing is exercised through the injectable stat reader, so these
 * cases run identically on macOS and Linux.
 */

import { describe, expect, test } from "bun:test"
import { isProcessAlive } from "../shared/platform"

const IS_LINUX = process.platform === "linux"

describe("isProcessAlive", () => {
  test("a pid that does not exist is dead on every platform", () => {
    // 2^22 is above the default pid_max on Linux and unused on macOS.
    expect(isProcessAlive(4_194_304)).toBe(false)
  })

  test("the current process is alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  test.skipIf(!IS_LINUX)("a zombie /proc state reads as dead", () => {
    const zombie = () => `${process.pid} (interceptor-dae) Z 1 ${process.pid} 0 -1 4194304 0 0`
    expect(isProcessAlive(process.pid, zombie)).toBe(false)
  })

  test.skipIf(!IS_LINUX)("a sleeping /proc state reads as alive", () => {
    const sleeping = () => `${process.pid} (interceptor-dae) S 1 ${process.pid} 0 -1 4194304 0 0`
    expect(isProcessAlive(process.pid, sleeping)).toBe(true)
  })

  test.skipIf(!IS_LINUX)("a comm containing spaces and parens does not shift the state field", () => {
    // /proc/<pid>/stat quotes comm in parens but does NOT escape parens or
    // spaces inside it, so the state token is only findable after the LAST ')'.
    const tricky = () => `${process.pid} (weird ) name (x) Z 1 ${process.pid} 0 -1 4194304 0 0`
    expect(isProcessAlive(process.pid, tricky)).toBe(false)
  })

  test.skipIf(!IS_LINUX)("an unreadable /proc entry falls back to the signal probe", () => {
    const missing = () => { throw new Error("ENOENT") }
    expect(isProcessAlive(process.pid, missing)).toBe(true)
  })
})
