// Issue #237: `interceptor back` / `forward` printed `error:` but exited 0, so a
// scripted check read the failure as success. The defect was the CLI's
// generic-action tail, which printed the result and never mapped
// `success:false` to a non-zero exit — every generic action (navigate, scroll,
// cookies, eval, …) shared it. Runs a real daemon under an isolated temp dir
// and port pair with a fake extension answering the forwarded actions, so the
// full CLI → daemon → extension → CLI exit path is exercised.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "bun"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const TEMP = mkdtempSync(join(tmpdir(), "interceptor-exit-"))
const WS_PORT = 38232
const IPC_PORT = 38231
const CONTEXT = "exit-code-test"
const ENV = {
  ...process.env,
  INTERCEPTOR_TEMP: TEMP,
  INTERCEPTOR_WS_PORT: String(WS_PORT),
  INTERCEPTOR_IPC_PORT: String(IPC_PORT),
  INTERCEPTOR_TIMEOUT: "500",
  FAKE_EXT_ACTIONS: join(TEMP, "actions.jsonl"),
  INTERCEPTOR_TASKS_DIR: join(TEMP, "tasks"),
}
const SOCK = join(TEMP, "interceptor.sock")
const PID = join(TEMP, "interceptor.pid")
const LOG = join(TEMP, "interceptor.log")
const UNIX = process.platform !== "win32"

let daemon: ReturnType<typeof spawn> | null = null
let fakeExt: ReturnType<typeof spawn> | null = null

async function waitFor(pred: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(100)
  }
  return pred()
}
function logHas(needle: string): boolean {
  return existsSync(LOG) && readFileSync(LOG, "utf-8").includes(needle)
}
async function cli(...args: string[]) {
  const proc = spawn({ cmd: ["bun", "run", "cli/index.ts", ...args], env: ENV, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), 30_000)
  const code = await proc.exited
  clearTimeout(timer)
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() }
}

beforeAll(async () => {
  daemon = spawn({ cmd: ["bun", "run", "daemon/index.ts", "--", "--standalone"], env: ENV, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  const ready = await waitFor(() => (!UNIX || existsSync(SOCK)) && existsSync(PID))
  if (!ready) throw new Error(`isolated daemon never became ready; log:\n${existsSync(LOG) ? readFileSync(LOG, "utf-8") : "(no log)"}`)
  fakeExt = spawn({
    cmd: ["bun", "run", "test/fixtures/fake-extension.ts"],
    env: { ...ENV, FAKE_EXT_WS_PORT: String(WS_PORT), FAKE_EXT_CONTEXT: CONTEXT, FAKE_EXT_VERSION: "0.0.0-fake" },
    stdout: "ignore", stderr: "inherit",
  })
  const registered = await waitFor(() => logHas(`ws extension registered [context: ${CONTEXT}]`))
  if (!registered) throw new Error(`fake extension never registered; log:\n${readFileSync(LOG, "utf-8")}`)
})

afterAll(async () => {
  fakeExt?.kill()
  daemon?.kill("SIGTERM")
  if (daemon) await daemon.exited
  rmSync(TEMP, { recursive: true, force: true })
})

describe("CLI exit codes follow the action result (issue #237)", () => {
  test("task checks honor leading and trailing WebSocket flags through CLI filtering", async () => {
    for (const op of ["verify", "complete"]) for (const placement of ["leading", "trailing", "ipc"]) {
      const created = await cli("monitor", "task", "create", "Transport fixture", "--json")
      expect(created.code).toBe(0)
      const { taskId } = JSON.parse(created.stdout)
      const file = join(TEMP, "transport-checkpoint.json")
      writeFileSync(file, JSON.stringify({ expectedRevision: 0, owner: "test", constraints: [], nextAction: "Verify", lessons: [],
        target: { contextId: CONTEXT, group: "fixture-task", tabId: 42, frameId: 12, origin: "https://example.com" }, checks: [{ id: "fixture", expression: "fixturePass" }] }))
      expect((await cli("monitor", "task", "checkpoint", taskId, "--file", file)).code).toBe(0)
      const args = ["monitor", "task", op, taskId]
      if (placement === "leading") args.unshift("--ws")
      if (placement === "trailing") args.push("--ws")
      const result = await cli(...args)
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout).verification.passed).toBe(true)
      expect(result.stderr.includes("→ws evaluate")).toBe(placement !== "ipc")
    }
  })

  test("task CLI persists across processes and gates completion on fresh checks", async () => {
    const created = await cli("monitor", "task", "create", "Verify fixture", "--json")
    expect(created.code).toBe(0)
    const { taskId } = JSON.parse(created.stdout)
    const file = join(TEMP, "checkpoint.json")
    const d = { expectedRevision: 0, owner: "test", constraints: ["No focus change"], nextAction: "Check fixture", lessons: [],
      target: { contextId: CONTEXT, group: "fixture-task", tabId: 42, frameId: 12, origin: "https://example.com" }, checks: [{ id: "fixture", expression: "fixtureFail" }] }
    writeFileSync(file, JSON.stringify(d))
    expect((await cli("monitor", "task", "checkpoint", taskId, "--file", file, "--json")).code).toBe(0)
    expect(JSON.parse((await cli("monitor", "task", "resume", taskId)).stdout).constraints).toEqual(d.constraints)
    const failed = await cli("monitor", "task", "complete", taskId, "--json")
    expect(failed.code).toBe(1)
    expect(JSON.parse(failed.stdout).status).toBe("active")
    d.expectedRevision = 1
    d.checks[0].expression = "fixturePass"
    writeFileSync(file, JSON.stringify(d))
    expect((await cli("monitor", "task", "checkpoint", taskId, "--file", file)).code).toBe(0)
    const completed = await cli("monitor", "task", "complete", taskId, "--json")
    expect(completed.code).toBe(0)
    expect(JSON.parse(completed.stdout)).toMatchObject({ status: "completed", verification: { passed: true, revision: 2 } })
    const actions = readFileSync(ENV.FAKE_EXT_ACTIONS, "utf8").trim().split("\n").map(s => JSON.parse(s))
    expect(actions.at(-1)).toMatchObject({ type: "evaluate", group: "fixture-task", groupSoft: false, frameId: 12, noCspReload: true })
  })

  test("act timeout remains uncertain and exits nonzero", async () => {
    const run = await cli("act", "e900", "--context", CONTEXT, "--json")
    expect(run.code).toBe(1)
    expect(run.stdout + run.stderr).not.toContain("page navigated")
  })

  test("act closed channel is not proof of navigation", async () => {
    const run = await cli("act", "e901", "--context", CONTEXT, "--json")
    expect(run.code).toBe(1)
    expect(JSON.parse(run.stdout).success).toBe(false)
  })

  test("act typing excludes global flags and their values", async () => {
    const run = await cli("act", "e902", "evidence", "--context", CONTEXT, "--json", "--no-read", "--frame", "12")
    expect(run.code).toBe(0)
    const actions = readFileSync(ENV.FAKE_EXT_ACTIONS, "utf8").trim().split("\n").map(s => JSON.parse(s))
    expect(actions.filter(a => a.ref === "e902").at(-1)).toMatchObject({ type: "input_text", text: "evidence", frameId: 12 })
  })

  test("act rejects an extra click verb with corrective usage", async () => {
    const run = await cli("act", "click", "e902", "--context", CONTEXT)
    expect(run.code).toBe(1)
    expect(run.stderr).toContain("act e902")
  })

  test("act reports a framed-ref conflict as local validation, not uncertain delivery", async () => {
    const run = await cli("--frame", "7", "--json", "act", "e12_1", "--context", CONTEXT)
    expect(run.code).toBe(1)
    expect(JSON.parse(run.stdout).error).toContain("element frame conflicts")
    expect(run.stdout + run.stderr).not.toContain("Delivery is unverified")
  })

  test("eval globals reach the wire without entering the code", async () => {
    const run = await cli("--frame=12", "eval", "--main", "1+1", "--context", CONTEXT, "--json")
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout).data).toMatchObject({ type: "evaluate", code: "1+1", world: "MAIN", frameId: 12 })
  })

  test("eval treats --help after the option terminator as literal code", async () => {
    const run = await cli("--frame", "12", "--json", "eval", "--context", CONTEXT, "--", "--help")
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout).data).toMatchObject({ type: "evaluate", code: "--help", frameId: 12 })
  })

  test("back with no history prints Chrome's error and exits 1", async () => {
    const run = await cli("back", "--context", CONTEXT)
    expect(run.stdout).toContain("error: Cannot find a next page in history.")
    expect(run.code).toBe(1)
  })

  test("forward with no history exits 1", async () => {
    const run = await cli("forward", "--context", CONTEXT)
    expect(run.stdout).toContain("error: Cannot find a next page in history.")
    expect(run.code).toBe(1)
  })

  test("--json failure keeps the JSON envelope and still exits 1", async () => {
    const run = await cli("back", "--context", CONTEXT, "--json")
    const body = JSON.parse(run.stdout)
    expect(body.success).toBe(false)
    expect(body.error).toBe("Cannot find a next page in history.")
    expect(run.code).toBe(1)
  })

  test("a successful generic action still exits 0", async () => {
    const run = await cli("navigate", "https://example.com", "--context", CONTEXT)
    expect(run.stdout.trim()).toBe("ok")
    expect(run.code).toBe(0)
  })

  test("compound open --json exits 1 when tab creation fails", async () => {
    const run = await cli("open", "https://example.com", "--context", CONTEXT, "--json")
    const body = JSON.parse(run.stdout)
    expect(body.success).toBe(false)
    expect(run.code).toBe(1)
  })

  test("the stale-snapshot hint path exits 1 too", async () => {
    // An action the fake does not know answers "unknown action type: …", the
    // symptom of a browser still running an older extension snapshot.
    const run = await cli("scroll", "down", "--context", CONTEXT)
    expect(run.stdout).toContain("error: unknown action type: scroll")
    expect(run.stderr).toContain("older Interceptor extension snapshot")
    expect(run.code).toBe(1)
  })

  test("contexts --verbose carries the version the extension registered with (issue #241)", async () => {
    const run = await cli("diagnose", "--json", "--context", CONTEXT)
    expect(run.code).toBe(0)
    const snap = JSON.parse(run.stdout)
    const ctx = snap.contexts.find((c: { contextId: string }) => c.contextId === CONTEXT)
    expect(ctx.extension.version).toBe("0.0.0-fake")
  })

  test("diagnose names the extension/CLI version mismatch and the reload fix", async () => {
    const run = await cli("diagnose", "--context", CONTEXT)
    expect(run.code).toBe(0)
    expect(run.stdout).toContain("extension: connected  (extension 0.0.0-fake)")
    expect(run.stdout).toContain("extension snapshot 0.0.0-fake ≠ CLI")
    expect(run.stdout).toContain(`interceptor reload --context ${CONTEXT}`)
  })
})
