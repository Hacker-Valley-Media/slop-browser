import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createMonitorTask, getMonitorTaskDir, readMonitorTaskMeta, readMonitorTaskEvents, updateMonitorTaskMeta, checkpointMonitorTask, resumeMonitorTask, verifyMonitorTask } from "../shared/monitor-tasks"

let root: string
const oldRoot = process.env.INTERCEPTOR_TASKS_DIR
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "task-state-")); process.env.INTERCEPTOR_TASKS_DIR = root })
afterEach(() => { rmSync(root, { recursive: true, force: true }); if (oldRoot) process.env.INTERCEPTOR_TASKS_DIR = oldRoot; else delete process.env.INTERCEPTOR_TASKS_DIR })

test("task mutation refuses contention instead of overwriting metadata", () => {
  const task = createMonitorTask({ instruction: "original" })
  mkdirSync(join(getMonitorTaskDir(task.taskId), ".mutation.lock"))
  expect(() => updateMonitorTaskMeta(task.taskId, t => ({ ...t, instruction: "lost" }))).toThrow("busy")
  expect(readMonitorTaskMeta(task.taskId)?.instruction).toBe("original")
})

test("task mutation reclaims a lock owned by a dead process", () => {
  const task = createMonitorTask({ instruction: "original" })
  const lock = join(getMonitorTaskDir(task.taskId), ".mutation.lock")
  mkdirSync(lock)
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 2_147_483_647, startedAt: 1 }))
  expect(updateMonitorTaskMeta(task.taskId, t => ({ ...t, instruction: "recovered" })).instruction).toBe("recovered")
  expect(readMonitorTaskMeta(task.taskId)?.instruction).toBe("recovered")
})

test("concurrent processes preserve every mutation, sequence, and readable JSON", async () => {
  const task = createMonitorTask({ instruction: "" })
  const script = `import {updateMonitorTaskMeta,appendMonitorTaskEvent} from ${JSON.stringify(resolve("shared/monitor-tasks.ts"))};
    for(let n=0;n<20;n++) for(;;) {try { updateMonitorTaskMeta(${JSON.stringify(task.taskId)},t=>({...t,instruction:t.instruction+'x'}));break } catch(e) {if(!String(e).includes('busy'))throw e;await Bun.sleep(2)} }
    for(let n=0;n<20;n++) for(;;) {try {appendMonitorTaskEvent(${JSON.stringify(task.taskId)},'task.resumed');break} catch(e) {if(!String(e).includes('busy'))throw e;await Bun.sleep(2)} }`
  const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, INTERCEPTOR_TASKS_DIR: root }, stdout: "ignore", stderr: "pipe" }))
  let finished = false
  const all = Promise.all(children.map(c => c.exited)).then(codes => { finished = true; return codes })
  while (!finished) {
    expect(JSON.parse(readFileSync(join(getMonitorTaskDir(task.taskId), "task.json"), "utf8")).taskId).toBe(task.taskId)
    await Bun.sleep(1)
  }
  const codes = await all
  if (codes.some(code => code !== 0)) throw new Error((await Promise.all(children.map(c => new Response(c.stderr).text()))).join("\n"))
  expect(codes).toEqual([0, 0, 0, 0])
  expect(readMonitorTaskMeta(task.taskId)?.instruction.length).toBe(80)
  expect(readMonitorTaskEvents(task.taskId).map(e => e.seq)).toEqual(Array.from({ length: 81 }, (_, i) => i))
})

const checkpoint = () => ({ expectedRevision: 0, owner: "agent-a", constraints: ["Keep background focus"],
  target: { contextId: "main", group: "owned-test", tabId: 42, frameId: 12, origin: "https://example.com" }, nextAction: "Check saved value",
  lessons: [
    { text: "Use fresh refs", source: "test:1", contextId: "main", origin: "https://example.com", status: "verified" },
    { text: "Old workaround", source: "test:2", contextId: "main", origin: "https://example.com", status: "superseded" },
    { text: "Other site", source: "test:3", contextId: "main", origin: "https://other.example", status: "verified" },
  ], checks: [{ id: "saved", expression: "document.title === 'Saved'" }] })

test("checkpoint persists exact constraints, scopes lessons, rejects stale and invalid targets", () => {
  const task = createMonitorTask({ instruction: "Save draft", mode: "agent-record" })
  const d = checkpoint()
  for (const target of [{ ...d.target, frameId: -1 }, { ...d.target, contextId: "" }, { ...d.target, origin: "https://example.com/path" }]) {
    expect(() => checkpointMonitorTask(task.taskId, { ...d, target })).toThrow()
  }
  checkpointMonitorTask(task.taskId, d)
  const resumed = resumeMonitorTask(task.taskId)
  expect(resumed).toMatchObject({ objective: "Save draft", revision: 1, owner: "agent-a", constraints: d.constraints, target: d.target })
  expect("lessons" in resumed && resumed.lessons).toHaveLength(1)
  expect(() => checkpointMonitorTask(task.taskId, d)).toThrow("stale checkpoint")
  expect(() => getMonitorTaskDir("../outside")).toThrow("invalid task")
})

test("completion requires fresh boolean true and unchanged checkpoints", async () => {
  const task = createMonitorTask({ instruction: "Save draft" })
  await expect(verifyMonitorTask(task.taskId, async () => ({ success: true, data: true }), true)).rejects.toThrow("no declared checks")
  checkpointMonitorTask(task.taskId, checkpoint())
  for (const value of [false, undefined, "true", 1, { value: true }]) {
    const checked = await verifyMonitorTask(task.taskId, async (target, code) => {
      expect(target.frameId).toBe(12)
      expect(code).toContain('location.origin!=="https://example.com"')
      return { success: true, data: value }
    }, true)
    expect(checked.status).toBe("active")
    expect(checked.verification?.passed).toBe(false)
  }
  expect((await verifyMonitorTask(task.taskId, async () => ({ success: true, data: true }), true)).status).toBe("completed")
  const completed = readMonitorTaskMeta(task.taskId)!
  const verified = await verifyMonitorTask(task.taskId, async () => ({ success: true, data: true }))
  expect(verified.status).toBe("completed")
  expect(verified.endedAt).toBe(completed.endedAt)
  const failedRecheck = await verifyMonitorTask(task.taskId, async () => ({ success: true, data: false }))
  expect(failedRecheck.status).toBe("completed")
  expect(failedRecheck.endedAt).toBe(completed.endedAt)
  expect(failedRecheck.verification?.passed).toBe(false)
  let repeatedCalls = 0
  await expect(verifyMonitorTask(task.taskId, async () => { repeatedCalls++; return { success: true, data: true } }, true)).rejects.toThrow("task is completed")
  expect(repeatedCalls).toBe(0)
  checkpointMonitorTask(task.taskId, { ...checkpoint(), expectedRevision: 1 })
  await expect(verifyMonitorTask(task.taskId, async () => {
    checkpointMonitorTask(task.taskId, { ...checkpoint(), expectedRevision: 2 })
    return { success: true, data: true }
  }, true)).rejects.toThrow("stale verification")
  expect(readMonitorTaskMeta(task.taskId)?.verification).toBeUndefined()
})

test("completion cannot overwrite a stop that happens while checks run", async () => {
  const task = createMonitorTask({ instruction: "Save draft" })
  checkpointMonitorTask(task.taskId, checkpoint())
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const completion = verifyMonitorTask(task.taskId, async () => {
    await waiting
    return { success: true, data: true }
  }, true)
  await Bun.sleep(1)
  const stopped = (await import("../shared/monitor-tasks")).stopMonitorTask(task.taskId)
  release()
  await expect(completion).rejects.toThrow("lifecycle changed")
  expect(readMonitorTaskMeta(task.taskId)).toMatchObject({ status: "stopped", endedAt: stopped.endedAt })
})
