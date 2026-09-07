import { describe, expect, test } from "bun:test"
import { captureSpinSample, SPIN_BUSY_FRACTION, SPIN_EXIT_TICKS, spinWatchdogStep, type SpinWatchdogState } from "../daemon/spin-watchdog"
import { readFileSync, statSync, rmSync } from "node:fs"
import { dirname } from "node:path"

test.skipIf(process.platform !== "darwin")("watchdog retains a private, bounded native stack sample", async () => {
  const started = Date.now()
  const result = await captureSpinSample()
  expect(result.error).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(16000)
  expect(statSync(result.path!).mode & 0o777).toBe(0o600)
  expect(readFileSync(result.path!, "utf8")).toContain("Call graph:")
  rmSync(dirname(result.path!), { recursive: true })
}, 17000)

// Issue #216: the keepalive tick feeds CPU-per-tick + an idle flag into this
// pure step; the daemon only logs/exits on its verdict.
const TICK_MS = 10_000
const busy = (fraction: number) => Math.round(fraction * TICK_MS * 1000) // µs over one tick

describe("spin watchdog step (issue #216)", () => {
  test("an idle daemon at ~0% CPU is ok and keeps the counter at zero", () => {
    const r = spinWatchdogStep({ busyIdleTicks: 3 }, { cpuMicros: busy(0.01), wallMs: TICK_MS, idle: true })
    expect(r.verdict).toBe("ok")
    expect(r.state.busyIdleTicks).toBe(0)
    expect(r.busyFraction).toBeCloseTo(0.01, 3)
  })

  test("busy but NOT idle (clients or in-flight work) is never a spin", () => {
    const r = spinWatchdogStep({ busyIdleTicks: 5 }, { cpuMicros: busy(1.0), wallMs: TICK_MS, idle: false })
    expect(r.verdict).toBe("ok")
    expect(r.state.busyIdleTicks).toBe(0)
  })

  test("busy-while-idle ticks accumulate to 'spinning' and then 'exit' at the threshold", () => {
    let state: SpinWatchdogState = { busyIdleTicks: 0 }
    for (let i = 1; i < SPIN_EXIT_TICKS; i++) {
      const r = spinWatchdogStep(state, { cpuMicros: busy(0.97), wallMs: TICK_MS, idle: true })
      expect(r.verdict).toBe("spinning")
      expect(r.state.busyIdleTicks).toBe(i)
      state = r.state
    }
    const last = spinWatchdogStep(state, { cpuMicros: busy(0.97), wallMs: TICK_MS, idle: true })
    expect(last.verdict).toBe("exit")
    expect(last.state.busyIdleTicks).toBe(SPIN_EXIT_TICKS)
  })

  test("one quiet tick resets the streak", () => {
    const spinning = spinWatchdogStep({ busyIdleTicks: SPIN_EXIT_TICKS - 1 }, { cpuMicros: busy(0.5), wallMs: TICK_MS, idle: true })
    expect(spinning.verdict).toBe("ok")
    expect(spinning.state.busyIdleTicks).toBe(0)
  })

  test("the threshold is a real fraction of the tick, not an absolute", () => {
    const under = spinWatchdogStep({ busyIdleTicks: 0 }, { cpuMicros: busy(SPIN_BUSY_FRACTION - 0.01), wallMs: TICK_MS, idle: true })
    const over = spinWatchdogStep({ busyIdleTicks: 0 }, { cpuMicros: busy(SPIN_BUSY_FRACTION + 0.01), wallMs: TICK_MS, idle: true })
    expect(under.verdict).toBe("ok")
    expect(over.verdict).toBe("spinning")
    // A longer-than-nominal tick (the machine slept) is judged against its own wall time.
    const slept = spinWatchdogStep({ busyIdleTicks: 0 }, { cpuMicros: busy(0.97), wallMs: TICK_MS * 4, idle: true })
    expect(slept.verdict).toBe("ok")
  })

  test("a zero-length tick cannot divide by zero", () => {
    const r = spinWatchdogStep({ busyIdleTicks: 0 }, { cpuMicros: 5, wallMs: 0, idle: true })
    expect(r.verdict).toBe("ok")
    expect(r.busyFraction).toBe(0)
  })
})
