import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import { TEMP, MONITOR_SESSIONS_DIR } from "./platform"
import {
  getSessionDir,
  hasSessionArtifacts,
  readSessionEvents,
  readSessionMeta,
  updateSessionMeta,
  type MonitorEvent,
  type MonitorSessionMeta,
} from "./monitor-artifacts"

export const MONITOR_TASK_MODES = ["human-observe", "human-teach", "agent-record", "mixed"] as const
export type MonitorTaskMode = typeof MONITOR_TASK_MODES[number]
export type MonitorTaskActorKind = "human" | "agent" | "system" | "verifier" | "guard"
export type MonitorTaskStatus = "active" | "paused" | "stopped" | "blocked" | "failed" | "aborted" | "completed"
export type MonitorTaskSurface = "browser" | "macos"

export type MonitorTaskPolicyRefs = {
  retentionPolicyId: string
  guardPolicyId: string
  verifierPolicyId?: string
  policyResolution: "task-may-restrict-only"
}

export type MonitorTaskActor = {
  kind: MonitorTaskActorKind
  id?: string
  firstSeenAt: number
  lastSeenAt?: number
}

export type MonitorTaskSourceSession = {
  sid: string
  surface: MonitorTaskSurface
  attachedAt: number
  detachedAt?: number
  rootTabId?: number
  rootPid?: number
  rootBundleId?: string
  rootApp?: string
  modeAtAttach: MonitorTaskMode
  actorAtAttach: MonitorTaskActorKind
  sourceArtifactRoot: string
  originalSourceArtifactRoot?: string
  sourceSnapshotRoot?: string
  sourceSnapshotStatus?: "complete" | "partial" | "blocked" | "failed"
  scope?: unknown
  status?: "attached" | "detached" | "source_stopped" | "source_failed"
}

export type MonitorTaskSourceAttachOptions = {
  actor?: MonitorTaskActorKind
  sourceArtifactRoot?: string
  surface?: MonitorTaskSurface
  rootTabId?: number
  rootPid?: number
  rootBundleId?: string
  rootApp?: string
  scope?: unknown
}

export type MonitorTaskTranscriptState = {
  rawSourcesPreserved: true
  mergeStrategy: "deterministic-timeline-then-ai-synthesis"
  evidenceTimelinePath?: string
  semanticTranscriptPath?: string
  lastSynthesizedAt?: number
  lastSynthesisModel?: string
  lastSynthesisStatus?: "never" | "partial" | "complete" | "failed"
}

export type MonitorTaskMeta = {
  artifactVersion: 1
  taskId: string
  instruction: string
  mode: MonitorTaskMode
  status: MonitorTaskStatus
  startedAt: number
  endedAt?: number
  storageRoot: string
  storageRootSource: "INTERCEPTOR_TASKS_DIR" | "INTERCEPTOR_RUNS_DIR" | "platform-default" | "temporary-fallback"
  durable: boolean
  createdBy: "browser-monitor" | "macos-monitor" | "task-api"
  sourceSessions: MonitorTaskSourceSession[]
  actors: MonitorTaskActor[]
  policyRefs: MonitorTaskPolicyRefs
  transcript: MonitorTaskTranscriptState
  defaultExportMode: "summary" | "redacted" | "full"
  checkpoint?: MonitorTaskCheckpoint
  verification?: MonitorTaskVerification
}

export type MonitorTaskTarget = { contextId: string; group: string; tabId: number; frameId: number; origin: string }
export type MonitorTaskCheckpoint = {
  revision: number
  updatedAt: number
  owner: string
  constraints: string[]
  target: MonitorTaskTarget
  nextAction: string
  lessons: Array<{ text: string; source: string; contextId: string; origin: string; status: "verified" | "unverified" | "superseded" }>
  checks: Array<{ id: string; expression: string }>
}
export type MonitorTaskVerification = {
  revision: number
  checkedAt: number
  target: MonitorTaskTarget
  passed: boolean
  results: Array<{ id: string; passed: boolean; observedAt: number; value?: unknown; error?: string }>
}

export type MonitorTaskSourceEvent = {
  version: 1
  taskId: string
  sid: string
  surface: MonitorTaskSurface
  action: "attached" | "detached" | "source_stopped" | "source_failed"
  timestamp: number
  actor: MonitorTaskActorKind
  modeAtAttach: MonitorTaskMode
  rootTabId?: number
  rootPid?: number
  rootBundleId?: string
  rootApp?: string
  sourceArtifactRoot?: string
  reason?: string
}

export type MonitorTaskSourceArtifactKind =
  | "session"
  | "events"
  | "network"
  | "attachments"
  | "media"
  | "diagnostic"
  | "binding"

export type MonitorTaskRetentionClass =
  | "task_metadata"
  | "raw_event"
  | "network_metadata"
  | "sensitive_payload"
  | "media"
  | "redacted"

export type MonitorTaskSourceManifestEntry = {
  version: 1
  taskId: string
  sid: string
  surface: MonitorTaskSurface
  originalPath: string
  taskPath?: string
  artifactKind: MonitorTaskSourceArtifactKind
  copiedAt?: number
  copyStrategy: "copy" | "hardlink" | "content_addressed" | "redacted" | "reference_only"
  sha256?: string
  bytes?: number
  rows?: number
  retentionClass: MonitorTaskRetentionClass
  status: "present" | "omitted_by_policy" | "missing" | "copy_failed"
  reason?: string
}

export type MonitorTaskScopePolicy = {
  version: 1
  taskId: string
  browser?: {
    allowedOrigins?: string[]
    allowedUrlPatterns?: string[]
    allowChildTabHandoff: "never" | "same_origin" | "same_site" | "explicit_allowlist" | "ask"
    externalHandoffDefault: "block" | "pause" | "label_sensitive" | "allow_with_diagnostic"
  }
  macos?: {
    allowedBundleIds?: string[]
    allowedApps?: string[]
    frontmostMode: "off" | "observe_switches_only" | "capture_scoped_apps" | "capture_all_with_diagnostics"
    highVolumeEvents: "drop" | "summarize" | "keep_in_timeline_only" | "keep_everywhere"
  }
  sensitiveDomains?: string[]
  sensitiveBundleIds?: string[]
}

export type TaskTimelineBoundary = "prelude" | "active" | "epilogue" | "out_of_bounds"

export type MonitorTaskDiagnostic = {
  version: 1
  taskId: string
  timestamp: number
  severity: "info" | "warning" | "error" | "blocker"
  code: string
  message: string
  sid?: string
  evidenceRefs?: string[]
  recommendedFix?: string
}

export type MonitorTaskEvent = {
  version: 1
  taskId: string
  timestamp: number
  seq: number
  type:
    | "task.created"
    | "task.paused"
    | "task.resumed"
    | "task.stopped"
    | "task.blocked"
    | "task.checkpoint"
    | "task.verified"
    | "task.completed"
    | "source.attach.requested"
    | "source.attached"
    | "source.detached"
    | "source.attach.failed"
    | "source.failed"
    | "timeline.created"
    | "transcript.synthesized"
    | "transcript.validation_failed"
    | "export.created"
  sid?: string
  actor: MonitorTaskActorKind
  payload?: Record<string, unknown>
}

export type MonitorTaskRoot = {
  root: string
  source: MonitorTaskMeta["storageRootSource"]
  durable: boolean
}

export type TaskTimelineEntry = {
  version: 1
  taskId: string
  entryId: string
  timestamp: number
  orderConfidence: "high" | "medium" | "low"
  sid: string
  surface: MonitorTaskSurface
  sourceEventKind: string
  sourceSeq?: number
  actor: MonitorTaskActorKind
  boundary: TaskTimelineBoundary
  boundaryReason?: string
  summary: string
  sourceRef: {
    sid: string
    surface: MonitorTaskSurface
    eventSeq?: number
    eventPath: string
    originalEventPath?: string
  }
  payload?: Record<string, unknown>
}

export type SemanticTranscriptEntry = {
  version: 1
  taskId: string
  entryId: string
  timestampStart: number
  timestampEnd: number
  actor: MonitorTaskActorKind
  summary: string
  intent?: string
  surfaces: MonitorTaskSurface[]
  sourceRefs: Array<{
    sid: string
    surface: MonitorTaskSurface
    eventSeq?: number
    eventPath?: string
    artifactPath?: string
  }>
  confidence: "high" | "medium" | "low"
  uncertainty?: string
  privacyLabels?: string[]
}

export type TeachableTranscriptSegment = {
  version: 1
  taskId: string
  segmentId: string
  sequence: number
  timestampStart: number
  timestampEnd: number
  boundary: Exclude<TaskTimelineBoundary, "out_of_bounds">
  actor: MonitorTaskActorKind
  surfaces: MonitorTaskSurface[]
  apps: Array<{
    surface: MonitorTaskSurface
    app?: string
    bundleId?: string
    origin?: string
    urlClass?: "same_origin" | "same_site" | "external" | "sensitive" | "unknown"
  }>
  title: string
  summary: string
  observedAction?: string
  observedOutcome?: string
  inferredIntent?: string
  decisionPoint?: boolean
  requiresHumanReview: boolean
  reviewReason?: string
  sourceRefs: SemanticTranscriptEntry["sourceRefs"]
  confidence: "high" | "medium" | "low"
  uncertainty?: string
  privacyLabels: string[]
  blueprintUse: "eligible" | "needs_review" | "not_reusable" | "sensitive" | "diagnostic_only"
}

export type MonitorTaskCaptureQualityReport = {
  version: 1
  taskId: string
  createdAt: number
  status: "excellent" | "usable_after_review" | "diagnostic_only" | "not_usable"
  scores: {
    sourceDurability: number
    sourceMetadataCompleteness: number
    lifecycleBoundaryCleanliness: number
    scopeDiscipline: number
    transcriptCompression: number
    evidenceCoverage: number
    privacyReadiness: number
    blueprintReadiness: number
  }
  counts: {
    sourceCount: number
    taskEventRows: number
    timelineRows: number
    transcriptRows: number
    segmentRows: number
    rawTitleSegments: number
    compressionRatioPermille: number
    missingSourceRefs: number
    tmpBackedSourceRefs: number
    preludeEvents: number
    activeEvents: number
    epilogueEvents: number
    outOfBoundsEvents: number
    sensitiveHandoffs: number
    reviewRequiredSegments: number
  }
  findings: Array<{
    severity: "info" | "warning" | "error" | "blocker"
    code: string
    message: string
    evidenceRefs?: string[]
    recommendedFix?: string
  }>
  gates: {
    reviewReady: boolean
    reducerReady: boolean
    verifierAuthoringReady: boolean
    blueprintCompilationReady: boolean
  }
}

export interface SemanticTranscriptSynthesizer {
  readonly name: string
  synthesize(task: MonitorTaskMeta, timeline: TaskTimelineEntry[]): SemanticTranscriptEntry[]
}

const DEFAULT_RETENTION_POLICY_ID = "default-local-redacted-retention"
const DEFAULT_GUARD_POLICY_ID = "default-require-approval-guard"

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function appendJsonl(path: string, value: unknown): void {
  appendFileSync(path, JSON.stringify(value) + "\n")
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, "utf-8")
  if (!raw.trim()) return []
  const out: T[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    const parsed = safeParse<T>(line)
    if (parsed) out.push(parsed)
  }
  return out
}

function writeJsonl(path: string, values: unknown[]): void {
  writeFileSync(path, values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""))
}

export function isMonitorTaskMode(value: unknown): value is MonitorTaskMode {
  return typeof value === "string" && (MONITOR_TASK_MODES as readonly string[]).includes(value)
}

export function validateMonitorTaskMode(value: unknown): MonitorTaskMode {
  if (value === undefined || value === null || value === "") return "human-observe"
  if (isMonitorTaskMode(value)) return value
  throw new Error(`invalid task mode '${String(value)}'; expected ${MONITOR_TASK_MODES.join("|")}`)
}

export function defaultActorForMode(mode: MonitorTaskMode): MonitorTaskActorKind {
  if (mode === "agent-record") return "agent"
  return "human"
}

export function resolveMonitorTasksRoot(): MonitorTaskRoot {
  if (process.env.INTERCEPTOR_TASKS_DIR) {
    return { root: process.env.INTERCEPTOR_TASKS_DIR, source: "INTERCEPTOR_TASKS_DIR", durable: true }
  }
  if (process.env.INTERCEPTOR_RUNS_DIR) {
    return { root: process.env.INTERCEPTOR_RUNS_DIR, source: "INTERCEPTOR_RUNS_DIR", durable: true }
  }

  const home = process.env.HOME || process.env.USERPROFILE
  if (process.platform === "darwin" && home) {
    return { root: join(home, "Library", "Application Support", "Interceptor", "tasks"), source: "platform-default", durable: true }
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || (home ? join(home, "AppData", "Roaming") : undefined)
    if (appData) return { root: join(appData, "Interceptor", "tasks"), source: "platform-default", durable: true }
  }
  if (home) {
    const stateHome = process.env.XDG_STATE_HOME || join(home, ".local", "state")
    return { root: join(stateHome, "interceptor", "tasks"), source: "platform-default", durable: true }
  }
  return { root: join(TEMP, "interceptor-tasks"), source: "temporary-fallback", durable: false }
}

export function ensureMonitorTasksRoot(): string {
  const { root } = resolveMonitorTasksRoot()
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return root
}

export function getMonitorTaskDir(taskId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(taskId)) throw new Error("invalid task id")
  return join(resolveMonitorTasksRoot().root, taskId)
}

export function getMonitorTaskMetaPath(taskId: string): string {
  return join(getMonitorTaskDir(taskId), "task.json")
}

export function getMonitorTaskSourcesPath(taskId: string): string {
  return join(getMonitorTaskDir(taskId), "sources.jsonl")
}

export function getMonitorTaskEventsPath(taskId: string): string {
  return join(getMonitorTaskDir(taskId), "events.jsonl")
}

export function getMonitorTaskTimelinePath(taskId: string): string {
  return join(getMonitorTaskDir(taskId), "timeline.jsonl")
}

export function getMonitorTaskTranscriptPath(taskId: string): string {
  return join(getMonitorTaskDir(taskId), "transcript.jsonl")
}

export function getMonitorTaskSourceManifestPath(taskId: string): string {
  return join(getMonitorTaskDir(taskId), "source-manifest.jsonl")
}

export function getMonitorTaskSourceSnapshotsDir(taskId: string): string {
  return join(getMonitorTaskDir(taskId), "source-snapshots")
}

export function getMonitorTaskSourceSnapshotDir(taskId: string, sid: string): string {
  return join(getMonitorTaskSourceSnapshotsDir(taskId), sid)
}

export function getMonitorTaskCaptureQualityPath(taskId: string): string {
  return join(getMonitorTaskDir(taskId), "capture-quality.json")
}

export function getMonitorTaskTranscriptSegmentsPath(taskId: string): string {
  return join(getMonitorTaskDir(taskId), "transcript-segments.jsonl")
}

export function getMonitorTaskDiagnosticsPath(taskId: string): string {
  return join(getMonitorTaskDir(taskId), "diagnostics.jsonl")
}

export function getMonitorTaskTimelineIndexPath(taskId: string): string {
  return join(getMonitorTaskDir(taskId), "timeline.index.json")
}

export function getMonitorTaskExportsDir(taskId: string): string {
  return join(getMonitorTaskDir(taskId), "exports")
}

export function ensureMonitorTaskDir(taskId: string): void {
  ensureMonitorTasksRoot()
  const dir = getMonitorTaskDir(taskId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function createMonitorTaskId(): string {
  return `task-${randomUUID().slice(0, 8).toLowerCase()}`
}

function nextTaskEventSeq(taskId: string): number {
  return readMonitorTaskEvents(taskId).length
}

export function readMonitorTaskMeta(taskId: string): MonitorTaskMeta | null {
  // Name resolution probes this reader before matching instruction text.
  let path: string
  try { path = getMonitorTaskMetaPath(taskId) } catch { return null }
  if (!existsSync(path)) return null
  return safeParse<MonitorTaskMeta>(readFileSync(path, "utf-8"))
}

const heldTaskLocks = new Set<string>()

function reclaimDeadTaskLock(lock: string): boolean {
  const owner = safeParse<{ pid?: number; startedAt?: number }>(readFileSync(join(lock, "owner.json"), "utf-8"))
  if (!owner || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return false
  try { process.kill(owner.pid as number, 0); return false } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") return false
  }
  const claim = join(lock, ".reclaim")
  try { writeFileSync(claim, String(process.pid), { flag: "wx", mode: 0o600 }) } catch { return false }
  try {
    const current = safeParse<{ pid?: number; startedAt?: number }>(readFileSync(join(lock, "owner.json"), "utf-8"))
    if (current?.pid !== owner.pid || current?.startedAt !== owner.startedAt) return false
    try { process.kill(owner.pid as number, 0); return false } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") return false
    }
    rmSync(lock, { recursive: true })
    return true
  } finally { if (existsSync(claim)) rmSync(claim, { force: true }) }
}

// Synchronous critical sections only. Contention is explicit, never a lost write.
function withTaskLock<T>(taskId: string, work: () => T): T {
  ensureMonitorTaskDir(taskId)
  const lock = join(getMonitorTaskDir(taskId), ".mutation.lock")
  if (heldTaskLocks.has(lock)) return work()
  try { mkdirSync(lock, { mode: 0o700 }) } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    let reclaimed = false
    try { reclaimed = reclaimDeadTaskLock(lock) } catch {}
    if (!reclaimed) throw new Error(`task busy: ${taskId}; retry after the other writer finishes. Automatic dead-owner reclaim did not apply; inspect ${lock}/owner.json before manual recovery.`)
    try { mkdirSync(lock, { mode: 0o700 }) } catch (retryErr) {
      if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`task busy: ${taskId}; retry after the other writer finishes.`)
      throw retryErr
    }
  }
  heldTaskLocks.add(lock)
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 })
    return work()
  } finally { heldTaskLocks.delete(lock); rmSync(lock, { recursive: true }) }
}

export function writeMonitorTaskMeta(meta: MonitorTaskMeta): void {
  withTaskLock(meta.taskId, () => {
    const path = getMonitorTaskMetaPath(meta.taskId)
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(meta, null, 2) + "\n", { flag: "wx", mode: 0o600 })
      renameSync(temp, path)
    } finally { rmSync(temp, { force: true }) }
  })
}

export function updateMonitorTaskMeta(
  taskId: string,
  updater: (current: MonitorTaskMeta) => MonitorTaskMeta
): MonitorTaskMeta {
  return withTaskLock(taskId, () => {
    const current = readMonitorTaskMeta(taskId)
    if (!current) throw new Error(`task not found: ${taskId}`)
    const next = updater(current)
    if (next.taskId !== taskId) throw new Error("task updater cannot change task identity")
    writeMonitorTaskMeta(next)
    return next
  })
}

export function appendMonitorTaskEvent(
  taskId: string,
  type: MonitorTaskEvent["type"],
  payload: {
    sid?: string
    actor?: MonitorTaskActorKind
    timestamp?: number
    payload?: Record<string, unknown>
  } = {}
): MonitorTaskEvent {
  return withTaskLock(taskId, () => {
  const event: MonitorTaskEvent = {
    version: 1,
    taskId,
    timestamp: payload.timestamp ?? Date.now(),
    seq: nextTaskEventSeq(taskId),
    type,
    ...(payload.sid ? { sid: payload.sid } : {}),
    actor: payload.actor || "system",
    ...(payload.payload ? { payload: payload.payload } : {}),
  }
  appendJsonl(getMonitorTaskEventsPath(taskId), event)
  return event
  })
}

export function readMonitorTaskEvents(taskId: string): MonitorTaskEvent[] {
  return readJsonl<MonitorTaskEvent>(getMonitorTaskEventsPath(taskId))
}

/** A checkpoint is authored state, not evidence that the objective is complete. */
export function checkpointMonitorTask(taskId: string, input: unknown): MonitorTaskMeta {
  const d = input as Record<string, any> | null
  const text = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v.length <= 16000
  const natural = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0
  const t = d?.target
  if (!d || !natural(d.expectedRevision) || !text(d.owner) || !text(d.nextAction)
    || !Array.isArray(d.constraints) || d.constraints.length > 100 || !d.constraints.every(text)
    || !t || !text(t.contextId) || !text(t.group) || !natural(t.tabId) || t.tabId === 0 || !natural(t.frameId)
    || !text(t.origin)) throw new Error("checkpoint requires expectedRevision, owner, constraints[], nextAction and target {contextId,group,tabId,frameId,origin}")
  try { if (!/^https?:$/.test(new URL(t.origin).protocol) || new URL(t.origin).origin !== t.origin) throw 0 }
  catch { throw new Error("target origin must be an exact http(s) origin, without a path") }
  if (!Array.isArray(d.checks) || d.checks.length > 50 || !d.checks.every((c: any) => c && text(c.id) && text(c.expression))
    || new Set(d.checks.map((c: any) => c.id)).size !== d.checks.length) throw new Error("checks must contain unique ids and nonempty JavaScript expressions (maximum 50)")
  if (!Array.isArray(d.lessons) || d.lessons.length > 100 || !d.lessons.every((l: any) => l && text(l.text) && text(l.source) && text(l.contextId) && text(l.origin) && ["verified", "unverified", "superseded"].includes(l.status))) throw new Error("lessons require text, source, contextId, origin and verified|unverified|superseded status")
  return updateMonitorTaskMeta(taskId, current => {
    const revision = current.checkpoint?.revision ?? 0
    if (revision !== d.expectedRevision) throw new Error(`stale checkpoint: expected revision ${d.expectedRevision}, current ${revision}; resume before writing`)
    const checkpoint: MonitorTaskCheckpoint = {
      revision: revision + 1, updatedAt: Date.now(), owner: d.owner, constraints: [...d.constraints], nextAction: d.nextAction,
      target: { contextId: t.contextId, group: t.group, tabId: t.tabId, frameId: t.frameId, origin: t.origin },
      checks: d.checks.map((c: any) => ({ id: c.id, expression: c.expression })),
      lessons: d.lessons.map((l: any) => ({ text: l.text, source: l.source, contextId: l.contextId, origin: l.origin, status: l.status })),
    }
    appendMonitorTaskEvent(taskId, "task.checkpoint", { actor: "agent", payload: { revision: checkpoint.revision, owner: checkpoint.owner } })
    return { ...current, status: "active", endedAt: undefined, checkpoint, verification: undefined }
  })
}

export function resumeMonitorTask(taskId: string) {
  const task = readMonitorTaskMeta(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  const c = task.checkpoint
  return {
    taskId, objective: task.instruction, status: task.status, durable: task.durable,
    ...(c ? { ...c, lessons: c.lessons.filter(l => l.status === "verified" && l.contextId === c.target.contextId && l.origin === c.target.origin) } : { revision: 0 }),
    verification: task.verification,
    evidenceScope: "Declared browser predicates only; checkpoint text and lesson status are author supplied.",
  }
}

/** Evaluate outside the disk lock, then reject a checkpoint changed during verification. */
export async function verifyMonitorTask(
  taskId: string,
  evaluate: (target: MonitorTaskTarget, code: string) => Promise<{ success: boolean; data?: unknown; error?: string }>,
  complete = false,
): Promise<MonitorTaskMeta> {
  const task = readMonitorTaskMeta(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  const c = task.checkpoint
  if (!c?.checks.length) throw new Error("task has no declared checks; checkpoint before verification or completion")
  if (complete && task.status !== "active") throw new Error(`task is ${task.status}; checkpoint it before completion`)
  const results: MonitorTaskVerification["results"] = []
  for (const check of c.checks) {
    // Each check tests the origin in the same frame and execution as its predicate.
    const code = `(async()=>{if(location.origin!==${JSON.stringify(c.target.origin)})throw new Error('task target origin changed');return await (${check.expression}\n)})()`
    try {
      const result = await evaluate(c.target, code)
      results.push({ id: check.id, passed: result.success && result.data === true, observedAt: Date.now(), value: result.data, ...(result.error ? { error: result.error } : {}) })
    } catch (err) { results.push({ id: check.id, passed: false, observedAt: Date.now(), error: err instanceof Error ? err.message : String(err) }) }
  }
  const verification: MonitorTaskVerification = { revision: c.revision, checkedAt: Date.now(), target: c.target, passed: results.every(r => r.passed), results }
  return updateMonitorTaskMeta(taskId, current => {
    if (JSON.stringify(current.checkpoint) !== JSON.stringify(c)) throw new Error("stale verification: checkpoint changed while checks ran; resume and verify again")
    if (current.status !== task.status || current.endedAt !== task.endedAt) throw new Error("stale verification: task lifecycle changed while checks ran; resume before verifying again")
    const completed = complete && verification.passed
    appendMonitorTaskEvent(taskId, completed ? "task.completed" : "task.verified", { actor: "verifier", payload: { verification } })
    return complete
      ? { ...current, verification, status: completed ? "completed" : "active", endedAt: completed ? verification.checkedAt : undefined }
      : { ...current, verification }
  })
}

export function appendMonitorTaskSourceEvent(event: MonitorTaskSourceEvent): void {
  ensureMonitorTaskDir(event.taskId)
  appendJsonl(getMonitorTaskSourcesPath(event.taskId), event)
}

export function readMonitorTaskSourceEvents(taskId: string): MonitorTaskSourceEvent[] {
  return readJsonl<MonitorTaskSourceEvent>(getMonitorTaskSourcesPath(taskId))
}

export function appendMonitorTaskDiagnostic(
  taskId: string,
  diagnostic: Omit<MonitorTaskDiagnostic, "version" | "taskId" | "timestamp"> & { timestamp?: number }
): MonitorTaskDiagnostic {
  ensureMonitorTaskDir(taskId)
  const entry: MonitorTaskDiagnostic = {
    version: 1,
    taskId,
    timestamp: diagnostic.timestamp ?? Date.now(),
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.sid ? { sid: diagnostic.sid } : {}),
    ...(diagnostic.evidenceRefs ? { evidenceRefs: diagnostic.evidenceRefs } : {}),
    ...(diagnostic.recommendedFix ? { recommendedFix: diagnostic.recommendedFix } : {}),
  }
  appendJsonl(getMonitorTaskDiagnosticsPath(taskId), entry)
  return entry
}

export function readMonitorTaskDiagnostics(taskId: string): MonitorTaskDiagnostic[] {
  return readJsonl<MonitorTaskDiagnostic>(getMonitorTaskDiagnosticsPath(taskId))
}

export function readMonitorTaskSourceManifest(taskId: string): MonitorTaskSourceManifestEntry[] {
  return readJsonl<MonitorTaskSourceManifestEntry>(getMonitorTaskSourceManifestPath(taskId))
}

export function listMonitorTaskIds(): string[] {
  const root = ensureMonitorTasksRoot()
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return statSync(getMonitorTaskDir(name)).isDirectory() && existsSync(getMonitorTaskMetaPath(name))
      } catch {
        return false
      }
    })
    .sort()
}

export function listMonitorTasks(): MonitorTaskMeta[] {
  return listMonitorTaskIds()
    .map((taskId) => readMonitorTaskMeta(taskId))
    .filter((task): task is MonitorTaskMeta => Boolean(task))
    .sort((a, b) => a.startedAt - b.startedAt)
}

export function activeMonitorTasks(): MonitorTaskMeta[] {
  return listMonitorTasks().filter((task) => task.status === "active" || task.status === "paused" || task.status === "blocked")
}

export function resolveMonitorTaskId(taskId?: string): string {
  if (taskId) {
    if (readMonitorTaskMeta(taskId)) return taskId
    // `--task "<name>"` creates a task keyed task-<id> with the given name
    // stored as `instruction` — resolve that name back to the id so quality/
    // snapshot/export can be addressed the way the task was created (#218).
    const byName = listMonitorTasks().filter((task) => task.instruction === taskId)
    if (byName.length === 1) return byName[0].taskId
    if (byName.length > 1) {
      throw new Error(`multiple tasks named '${taskId}': ${byName.map((task) => task.taskId).join(", ")} — pass the taskId`)
    }
    throw new Error(`task not found: ${taskId}`)
  }
  const active = activeMonitorTasks()
  if (active.length === 0) throw new Error("no active task; pass --task <taskId>")
  if (active.length > 1) throw new Error("multiple active tasks; pass --task <taskId>")
  return active[0].taskId
}

export function createMonitorTask(input: {
  instruction: string
  mode?: string
  createdBy?: MonitorTaskMeta["createdBy"]
  retentionPolicyId?: string
  guardPolicyId?: string
  verifierPolicyId?: string
  defaultExportMode?: MonitorTaskMeta["defaultExportMode"]
}): MonitorTaskMeta {
  const mode = validateMonitorTaskMode(input.mode)
  const root = resolveMonitorTasksRoot()
  const startedAt = Date.now()
  let taskId = createMonitorTaskId()
  while (readMonitorTaskMeta(taskId)) taskId = createMonitorTaskId()
  const actor = defaultActorForMode(mode)
  const meta: MonitorTaskMeta = {
    artifactVersion: 1,
    taskId,
    instruction: input.instruction,
    mode,
    status: "active",
    startedAt,
    storageRoot: root.root,
    storageRootSource: root.source,
    durable: root.durable,
    createdBy: input.createdBy || "task-api",
    sourceSessions: [],
    actors: [{ kind: actor, firstSeenAt: startedAt }],
    policyRefs: {
      retentionPolicyId: input.retentionPolicyId || DEFAULT_RETENTION_POLICY_ID,
      guardPolicyId: input.guardPolicyId || DEFAULT_GUARD_POLICY_ID,
      ...(input.verifierPolicyId ? { verifierPolicyId: input.verifierPolicyId } : {}),
      policyResolution: "task-may-restrict-only",
    },
    transcript: {
      rawSourcesPreserved: true,
      mergeStrategy: "deterministic-timeline-then-ai-synthesis",
      lastSynthesisStatus: "never",
    },
    defaultExportMode: input.defaultExportMode || "redacted",
  }
  writeMonitorTaskMeta(meta)
  appendMonitorTaskEvent(taskId, "task.created", { actor, timestamp: startedAt, payload: { createdBy: meta.createdBy } })
  return meta
}

export function resolveOrCreateMonitorTask(input: {
  taskRef: string
  mode?: string
  createdBy?: MonitorTaskMeta["createdBy"]
  instruction?: string
  retentionPolicyId?: string
  guardPolicyId?: string
  verifierPolicyId?: string
}): { task: MonitorTaskMeta; created: boolean } {
  const existing = readMonitorTaskMeta(input.taskRef)
  if (existing) return { task: existing, created: false }
  if (input.taskRef.startsWith("task-")) {
    throw new Error(`task not found: ${input.taskRef}`)
  }
  return {
    task: createMonitorTask({
      instruction: input.instruction || input.taskRef,
      mode: input.mode,
      createdBy: input.createdBy,
      retentionPolicyId: input.retentionPolicyId,
      guardPolicyId: input.guardPolicyId,
      verifierPolicyId: input.verifierPolicyId,
    }),
    created: true,
  }
}

function inferSurface(meta: MonitorSessionMeta | null, events: MonitorEvent[]): MonitorTaskSurface {
  if (meta?.surface === "macos") return "macos"
  if (events.some((event) => event.surface === "macos" || event.rootPid !== undefined || event.rootApp !== undefined)) return "macos"
  return "browser"
}

export function defaultMonitorTaskScopePolicy(task: MonitorTaskMeta): MonitorTaskScopePolicy {
  const browserOrigins = new Set<string>()
  const bundleIds = new Set<string>()
  const apps = new Set<string>()
  for (const source of task.sourceSessions) {
    if (source.rootBundleId) bundleIds.add(source.rootBundleId)
    if (source.rootApp) apps.add(source.rootApp)
    const meta = readSessionMeta(source.sid)
    if (meta?.url) {
      try {
        browserOrigins.add(new URL(meta.url).origin)
      } catch {}
    }
  }
  return {
    version: 1,
    taskId: task.taskId,
    browser: {
      allowedOrigins: [...browserOrigins],
      allowedUrlPatterns: [],
      allowChildTabHandoff: "ask",
      externalHandoffDefault: "label_sensitive",
    },
    macos: {
      allowedBundleIds: [...bundleIds],
      allowedApps: [...apps],
      frontmostMode: task.mode === "human-teach" ? "capture_all_with_diagnostics" : "observe_switches_only",
      highVolumeEvents: "summarize",
    },
    sensitiveDomains: [
      "stripe.com",
      "invoice.stripe.com",
      "paypal.com",
      "billing",
      "bank",
      "account",
      "login",
      "auth",
      "password",
      "settings",
    ],
    sensitiveBundleIds: [
      "com.apple.keychainaccess",
      "com.apple.systempreferences",
      "com.apple.systemsettings",
    ],
  }
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function jsonlRowCount(path: string): number | undefined {
  if (!existsSync(path)) return undefined
  const raw = readFileSync(path, "utf-8")
  if (!raw.trim()) return 0
  return raw.split("\n").filter((line) => line.trim()).length
}

function eventKindCounts(path: string): { evt: number; mut: number; net: number; nav: number } {
  const counts = { evt: 0, mut: 0, net: 0, nav: 0 }
  if (!existsSync(path)) return counts
  for (const event of readJsonl<MonitorEvent>(path)) {
    counts.evt += 1
    if (event.event === "mut") counts.mut += 1
    if (event.event === "nav") counts.nav += 1
    if (["fetch", "xhr", "sse", "ws_opening", "ws_open", "ws_send", "ws_message", "ws_error", "ws_close", "beacon", "broadcast_send", "broadcast_message"].includes(String(event.event || ""))) {
      counts.net += 1
    }
  }
  return counts
}

function lastTimestampFromEvents(path: string): number | undefined {
  if (!existsSync(path)) return undefined
  let last: number | undefined
  for (const event of readJsonl<MonitorEvent>(path)) {
    const time = timestampForEvent(event, last ?? 0)
    if (Number.isFinite(time.timestamp)) last = Math.max(last ?? time.timestamp, time.timestamp)
  }
  return last
}

export function chooseSourceSnapshotStrategy(): MonitorTaskSourceManifestEntry["copyStrategy"] {
  const configured = process.env.INTERCEPTOR_TASK_SNAPSHOT_STRATEGY
  if (configured === "hardlink" || configured === "copy" || configured === "content_addressed") return configured
  return "copy"
}

function retentionClassForArtifact(kind: MonitorTaskSourceArtifactKind): MonitorTaskRetentionClass {
  if (kind === "session" || kind === "binding" || kind === "diagnostic") return "task_metadata"
  if (kind === "network") return "network_metadata"
  if (kind === "media") return "media"
  return "raw_event"
}

function sourceArtifactPath(root: string, kind: MonitorTaskSourceArtifactKind): string {
  if (kind === "session") return join(root, "session.json")
  if (kind === "events") return join(root, "events.jsonl")
  if (kind === "network") return join(root, "net.jsonl")
  if (kind === "attachments") return join(root, "attachments.jsonl")
  if (kind === "binding") return join(root, "task-binding.json")
  if (kind === "diagnostic") return join(root, "diagnostic.json")
  return join(root, "media")
}

function copyFileWithStrategy(from: string, to: string, strategy: MonitorTaskSourceManifestEntry["copyStrategy"]): MonitorTaskSourceManifestEntry["copyStrategy"] {
  ensureDir(join(to, ".."))
  if (strategy === "hardlink") {
    try {
      linkSync(from, to)
      return "hardlink"
    } catch {
      copyFileSync(from, to)
      return "copy"
    }
  }
  copyFileSync(from, to)
  return strategy === "content_addressed" ? "content_addressed" : "copy"
}

function copyDirectoryRecursive(from: string, to: string): void {
  ensureDir(to)
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dest = join(to, entry.name)
    if (entry.isDirectory()) copyDirectoryRecursive(src, dest)
    else if (entry.isFile()) copyFileSync(src, dest)
  }
}

function manifestForExistingFile(
  taskId: string,
  source: MonitorTaskSourceSession,
  originalPath: string,
  taskPath: string,
  artifactKind: MonitorTaskSourceArtifactKind,
  strategy: MonitorTaskSourceManifestEntry["copyStrategy"]
): MonitorTaskSourceManifestEntry {
  const stat = statSync(taskPath)
  return {
    version: 1,
    taskId,
    sid: source.sid,
    surface: source.surface,
    originalPath,
    taskPath,
    artifactKind,
    copiedAt: Date.now(),
    copyStrategy: strategy,
    sha256: stat.isFile() ? sha256File(taskPath) : undefined,
    bytes: stat.isFile() ? stat.size : undefined,
    rows: stat.isFile() && taskPath.endsWith(".jsonl") ? jsonlRowCount(taskPath) : undefined,
    retentionClass: retentionClassForArtifact(artifactKind),
    status: "present",
  }
}

function writeTaskBinding(task: MonitorTaskMeta, source: MonitorTaskSourceSession, snapshotDir: string): MonitorTaskSourceManifestEntry {
  ensureDir(snapshotDir)
  const bindingPath = sourceArtifactPath(snapshotDir, "binding")
  writeFileSync(bindingPath, JSON.stringify({
    version: 1,
    taskId: task.taskId,
    sid: source.sid,
    surface: source.surface,
    modeAtAttach: source.modeAtAttach,
    actorAtAttach: source.actorAtAttach,
    attachedAt: source.attachedAt,
    sourceArtifactRoot: source.sourceArtifactRoot,
  }, null, 2) + "\n")
  return manifestForExistingFile(task.taskId, source, bindingPath, bindingPath, "binding", "copy")
}

function bindSourceSessionMetadata(task: MonitorTaskMeta, source: MonitorTaskSourceSession): boolean {
  try {
    updateSessionMeta(source.sid, (current) => {
      const base: MonitorSessionMeta = current || {
        artifactVersion: source.surface === "macos" ? 1 : 2,
        surface: source.surface,
        sessionId: source.sid,
        startedAt: source.attachedAt,
        status: "active",
        paused: false,
        attachments: [],
      }
      return {
        ...base,
        surface: source.surface,
        taskId: task.taskId,
        taskModeAtAttach: source.modeAtAttach,
        taskActorAtAttach: source.actorAtAttach,
        taskAttachedAt: source.attachedAt,
        ...(source.detachedAt ? { taskDetachedAt: source.detachedAt } : {}),
        ...(source.sourceSnapshotRoot ? { taskSourceSnapshotRoot: source.sourceSnapshotRoot } : {}),
        rootTabId: base.rootTabId ?? source.rootTabId,
        rootPid: base.rootPid ?? source.rootPid,
        rootBundleId: base.rootBundleId ?? source.rootBundleId,
        rootApp: base.rootApp ?? source.rootApp,
      }
    })
    return true
  } catch {
    return false
  }
}

function sourceFromSession(
  task: MonitorTaskMeta,
  sid: string,
  options: MonitorTaskSourceAttachOptions = {}
): MonitorTaskSourceSession {
  const meta = readSessionMeta(sid)
  const events = readSessionEvents(sid)
  const hasArtifacts = Boolean(meta) || events.length > 0 || hasSessionArtifacts(sid)
  if (!hasArtifacts && !options.surface) {
    throw new Error(`monitor session not found: ${sid}`)
  }
  const start = events.find((event) => event.event === "mon_start")
  const surface = options.surface || inferSurface(meta, events)
  return {
    sid,
    surface,
    attachedAt: Date.now(),
    rootTabId: meta?.rootTabId ?? options.rootTabId ?? (typeof start?.tid === "number" ? start.tid : undefined),
    rootPid: meta?.rootPid ?? options.rootPid ?? (typeof start?.rootPid === "number" ? start.rootPid : undefined),
    rootBundleId: meta?.rootBundleId ?? options.rootBundleId ?? (typeof start?.rootBundleId === "string" ? start.rootBundleId : undefined),
    rootApp: meta?.rootApp ?? options.rootApp ?? (typeof start?.rootApp === "string" ? start.rootApp : undefined),
    modeAtAttach: task.mode,
    actorAtAttach: options.actor || defaultActorForMode(task.mode),
    sourceArtifactRoot: options.sourceArtifactRoot || getSessionDir(sid),
    scope: meta?.scope ?? options.scope,
    status: "attached",
  }
}

export function findActiveTaskForSourceSession(sid: string, excludeTaskId?: string): MonitorTaskMeta | undefined {
  return activeMonitorTasks().find((task) => (
    task.taskId !== excludeTaskId &&
    task.sourceSessions.some((source) => source.sid === sid && source.status !== "detached")
  ))
}

export function attachMonitorTaskSource(
  taskId: string,
  sid: string,
  options: MonitorTaskSourceAttachOptions = {}
): { task: MonitorTaskMeta; source: MonitorTaskSourceSession } {
  const task = readMonitorTaskMeta(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  const existingActive = findActiveTaskForSourceSession(sid, taskId)
  if (existingActive) throw new Error(`session ${sid} is already attached to active task ${existingActive.taskId}`)

  const existing = task.sourceSessions.find((source) => source.sid === sid && source.status !== "detached")
  if (existing) return { task, source: existing }

  const source = sourceFromSession(task, sid, options)
  const bound = bindSourceSessionMetadata(task, source)
  appendMonitorTaskEvent(taskId, "source.attach.requested", { sid, actor: source.actorAtAttach })
  appendMonitorTaskSourceEvent({
    version: 1,
    taskId,
    sid,
    surface: source.surface,
    action: "attached",
    timestamp: source.attachedAt,
    actor: source.actorAtAttach,
    modeAtAttach: source.modeAtAttach,
    rootTabId: source.rootTabId,
    rootPid: source.rootPid,
    rootBundleId: source.rootBundleId,
    rootApp: source.rootApp,
    sourceArtifactRoot: source.sourceArtifactRoot,
  })
  const updated = updateMonitorTaskMeta(taskId, (current) => ({
    ...current,
    sourceSessions: [...current.sourceSessions.filter((item) => item.sid !== sid), source],
    actors: touchActor(current.actors, source.actorAtAttach, source.attachedAt),
  }))
  appendMonitorTaskEvent(taskId, "source.attached", { sid, actor: source.actorAtAttach, payload: { surface: source.surface } })
  if (!bound) {
    appendMonitorTaskDiagnostic(taskId, {
      severity: "warning",
      code: "source_metadata_binding_sidecar_required",
      sid,
      message: `Could not update source session metadata for ${sid}; task-owned binding metadata will be used.`,
      recommendedFix: "Run interceptor monitor repair --task <taskId> --snapshot-sources while source artifacts are still available.",
    })
  }
  return { task: updated, source }
}

export function detachMonitorTaskSource(
  taskId: string,
  sid: string,
  options: { actor?: MonitorTaskActorKind; reason?: string } = {}
): { task: MonitorTaskMeta; source: MonitorTaskSourceSession } {
  const task = readMonitorTaskMeta(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  const source = task.sourceSessions.find((item) => item.sid === sid && item.status !== "detached")
  if (!source) throw new Error(`session ${sid} is not attached to task ${taskId}`)
  const detachedAt = Date.now()
  const actor = options.actor || source.actorAtAttach
  const detachedSource: MonitorTaskSourceSession = {
    ...source,
    detachedAt,
    status: "detached",
  }
  appendMonitorTaskSourceEvent({
    version: 1,
    taskId,
    sid,
    surface: source.surface,
    action: "detached",
    timestamp: detachedAt,
    actor,
    modeAtAttach: source.modeAtAttach,
    rootTabId: source.rootTabId,
    rootPid: source.rootPid,
    rootBundleId: source.rootBundleId,
    rootApp: source.rootApp,
    sourceArtifactRoot: source.sourceArtifactRoot,
    reason: options.reason,
  })
  const updated = updateMonitorTaskMeta(taskId, (current) => ({
    ...current,
    sourceSessions: current.sourceSessions.map((item) => item.sid === sid ? detachedSource : item),
    actors: touchActor(current.actors, actor, detachedAt),
  }))
  appendMonitorTaskEvent(taskId, "source.detached", {
    sid,
    actor,
    timestamp: detachedAt,
    payload: { reason: options.reason },
  })
  return { task: updated, source: detachedSource }
}

function touchActor(actors: MonitorTaskActor[], kind: MonitorTaskActorKind, at: number): MonitorTaskActor[] {
  const idx = actors.findIndex((actor) => actor.kind === kind)
  if (idx === -1) return [...actors, { kind, firstSeenAt: at, lastSeenAt: at }]
  return actors.map((actor, i) => i === idx ? { ...actor, lastSeenAt: at } : actor)
}

export function markMonitorTaskSourceAttachFailed(
  taskId: string,
  sid: string | undefined,
  error: string,
  actor: MonitorTaskActorKind = "system"
): MonitorTaskMeta {
  const timestamp = Date.now()
  const updated = updateMonitorTaskMeta(taskId, (current) => ({
    ...current,
    status: current.sourceSessions.length === 0 ? "blocked" : current.status,
  }))
  appendMonitorTaskEvent(taskId, "source.attach.failed", {
    sid,
    actor,
    timestamp,
    payload: { error },
  })
  if (updated.status === "blocked") {
    appendMonitorTaskEvent(taskId, "task.blocked", { actor, timestamp, payload: { reason: "source_attach_failed" } })
  }
  return updated
}

function copySourceArtifact(
  task: MonitorTaskMeta,
  source: MonitorTaskSourceSession,
  originalRoot: string,
  snapshotDir: string,
  artifactKind: MonitorTaskSourceArtifactKind,
  required: boolean,
  strategy: MonitorTaskSourceManifestEntry["copyStrategy"]
): MonitorTaskSourceManifestEntry {
  const originalPath = sourceArtifactPath(originalRoot, artifactKind)
  const taskPath = sourceArtifactPath(snapshotDir, artifactKind)
  if (!existsSync(originalPath)) {
    return {
      version: 1,
      taskId: task.taskId,
      sid: source.sid,
      surface: source.surface,
      originalPath,
      artifactKind,
      copyStrategy: "reference_only",
      retentionClass: retentionClassForArtifact(artifactKind),
      status: "missing",
      reason: required ? "required_source_artifact_missing" : "optional_source_artifact_not_present",
    }
  }

  try {
    const stat = statSync(originalPath)
    if (stat.isDirectory()) {
      copyDirectoryRecursive(originalPath, taskPath)
      return {
        version: 1,
        taskId: task.taskId,
        sid: source.sid,
        surface: source.surface,
        originalPath,
        taskPath,
        artifactKind,
        copiedAt: Date.now(),
        copyStrategy: "copy",
        retentionClass: retentionClassForArtifact(artifactKind),
        status: "present",
      }
    }
    const usedStrategy = copyFileWithStrategy(originalPath, taskPath, strategy)
    return manifestForExistingFile(task.taskId, source, originalPath, taskPath, artifactKind, usedStrategy)
  } catch (err) {
    return {
      version: 1,
      taskId: task.taskId,
      sid: source.sid,
      surface: source.surface,
      originalPath,
      taskPath,
      artifactKind,
      copyStrategy: "reference_only",
      retentionClass: retentionClassForArtifact(artifactKind),
      status: "copy_failed",
      reason: (err as Error).message,
    }
  }
}

function updateSnapshotSessionMeta(task: MonitorTaskMeta, source: MonitorTaskSourceSession, snapshotDir: string): void {
  const snapshotMetaPath = sourceArtifactPath(snapshotDir, "session")
  if (!existsSync(snapshotMetaPath)) return
  const parsed = safeParse<MonitorSessionMeta>(readFileSync(snapshotMetaPath, "utf-8"))
  if (!parsed) return
  const eventsPath = sourceArtifactPath(snapshotDir, "events")
  const netPath = sourceArtifactPath(snapshotDir, "network")
  const eventCounts = eventKindCounts(eventsPath)
  const netRows = jsonlRowCount(netPath)
  const finalizedAt = Date.now()
  const endedAt = parsed.endedAt ?? task.endedAt ?? lastTimestampFromEvents(eventsPath) ?? finalizedAt
  writeFileSync(snapshotMetaPath, JSON.stringify({
    ...parsed,
    surface: source.surface,
    taskId: task.taskId,
    status: "stopped",
    endedAt,
    stopReason: parsed.stopReason || "task_snapshot_finalized",
    counts: {
      evt: eventCounts.evt || parsed.counts?.evt || 0,
      mut: eventCounts.mut || parsed.counts?.mut || 0,
      net: netRows ?? (eventCounts.net || parsed.counts?.net || 0),
      nav: eventCounts.nav || parsed.counts?.nav || 0,
      ...(parsed.counts?.ax !== undefined ? { ax: parsed.counts.ax } : {}),
    },
    taskModeAtAttach: source.modeAtAttach,
    taskActorAtAttach: source.actorAtAttach,
    taskAttachedAt: source.attachedAt,
    ...(source.detachedAt ? { taskDetachedAt: source.detachedAt } : {}),
    taskSourceSnapshotRoot: snapshotDir,
    taskSourceStatusAtSnapshot: parsed.status,
    taskSnapshotFinalizedAt: finalizedAt,
  }, null, 2) + "\n")
}

export function snapshotMonitorTaskSources(taskId: string): MonitorTaskSourceManifestEntry[] {
  const task = readMonitorTaskMeta(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  ensureMonitorTaskDir(taskId)
  ensureDir(getMonitorTaskSourceSnapshotsDir(taskId))
  const manifest: MonitorTaskSourceManifestEntry[] = []
  const strategy = chooseSourceSnapshotStrategy()
  const updatedSources: MonitorTaskSourceSession[] = []

  for (const source of task.sourceSessions) {
    const originalRoot = source.originalSourceArtifactRoot || source.sourceArtifactRoot || getSessionDir(source.sid)
    const snapshotDir = getMonitorTaskSourceSnapshotDir(taskId, source.sid)
    ensureDir(snapshotDir)
    const entries = [
      copySourceArtifact(task, source, originalRoot, snapshotDir, "session", true, strategy),
      copySourceArtifact(task, source, originalRoot, snapshotDir, "events", true, strategy),
      copySourceArtifact(task, source, originalRoot, snapshotDir, "network", false, strategy),
      copySourceArtifact(task, source, originalRoot, snapshotDir, "attachments", false, strategy),
      copySourceArtifact(task, source, originalRoot, snapshotDir, "media", false, strategy),
    ]
    updateSnapshotSessionMeta(task, source, snapshotDir)
    const binding = writeTaskBinding(task, source, snapshotDir)
    manifest.push(...entries, binding)

    const requiredEntries = entries.filter((entry) => entry.artifactKind === "session" || entry.artifactKind === "events")
    const requiredPresent = requiredEntries.filter((entry) => entry.status === "present").length
    const snapshotStatus: MonitorTaskSourceSession["sourceSnapshotStatus"] =
      requiredPresent === requiredEntries.length ? "complete" :
        requiredPresent > 0 ? "partial" :
          requiredEntries.some((entry) => entry.status === "copy_failed") ? "failed" : "blocked"
    const nextSource: MonitorTaskSourceSession = {
      ...source,
      originalSourceArtifactRoot: originalRoot,
      sourceArtifactRoot: snapshotStatus === "complete" || snapshotStatus === "partial" ? snapshotDir : source.sourceArtifactRoot,
      sourceSnapshotRoot: snapshotDir,
      sourceSnapshotStatus: snapshotStatus,
    }
    bindSourceSessionMetadata(task, nextSource)
    updatedSources.push(nextSource)

    if (snapshotStatus !== "complete") {
      appendMonitorTaskDiagnostic(taskId, {
        severity: snapshotStatus === "partial" ? "warning" : "error",
        code: "source_snapshot_incomplete",
        sid: source.sid,
        message: `Source snapshot for ${source.surface} session ${source.sid} is ${snapshotStatus}.`,
        recommendedFix: "Run interceptor monitor repair --task <taskId> --snapshot-sources before temporary source artifacts are removed.",
      })
    }
  }

  writeJsonl(getMonitorTaskSourceManifestPath(taskId), manifest)
  updateMonitorTaskMeta(taskId, (current) => ({
    ...current,
    sourceSessions: current.sourceSessions.map((source) => updatedSources.find((item) => item.sid === source.sid) || source),
  }))
  return manifest
}

export function validateMonitorTaskSourceBindings(taskId: string): MonitorTaskDiagnostic[] {
  const task = readMonitorTaskMeta(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  const diagnostics: MonitorTaskDiagnostic[] = []
  for (const source of task.sourceSessions) {
    const metaPath = source.sourceSnapshotRoot ? sourceArtifactPath(source.sourceSnapshotRoot, "session") : undefined
    const snapshotMeta = metaPath && existsSync(metaPath) ? safeParse<MonitorSessionMeta>(readFileSync(metaPath, "utf-8")) : null
    const liveMeta = readSessionMeta(source.sid)
    const bindingPath = sourceArtifactPath(source.sourceSnapshotRoot || getMonitorTaskSourceSnapshotDir(taskId, source.sid), "binding")
    const hasBinding = existsSync(bindingPath)
    const effectiveSurface = snapshotMeta?.surface || liveMeta?.surface
    const effectiveTaskId = snapshotMeta?.taskId || liveMeta?.taskId
    if (effectiveSurface !== source.surface) {
      diagnostics.push(appendMonitorTaskDiagnostic(taskId, {
        severity: "error",
        code: "source_surface_mismatch",
        sid: source.sid,
        message: `Source ${source.sid} metadata surface is ${String(effectiveSurface)} but task membership expects ${source.surface}.`,
      }))
    }
    if (effectiveTaskId !== taskId && !hasBinding) {
      diagnostics.push(appendMonitorTaskDiagnostic(taskId, {
        severity: "error",
        code: "source_task_binding_missing",
        sid: source.sid,
        message: `Source ${source.sid} metadata is not bound to task ${taskId} and no task-owned binding sidecar exists.`,
        recommendedFix: "Run monitor task snapshot <taskId> while source artifacts are still available.",
      }))
    }
  }
  return diagnostics
}

export function stopMonitorTask(
  taskId: string,
  options: { actor?: MonitorTaskActorKind; stopSourcesRequested?: boolean } = {}
): MonitorTaskMeta {
  const endedAt = Date.now()
  const task = updateMonitorTaskMeta(taskId, (current) => ({
    ...current,
    status: "stopped",
    endedAt,
  }))
  appendMonitorTaskEvent(taskId, "task.stopped", {
    actor: options.actor || "system",
    timestamp: endedAt,
    payload: { stopSourcesRequested: options.stopSourcesRequested === true },
  })
  if (options.stopSourcesRequested) {
    for (const source of task.sourceSessions) {
      const meta = readSessionMeta(source.sid)
      if (!meta || meta.status !== "stopped") {
        appendMonitorTaskDiagnostic(taskId, {
          severity: "warning",
          code: "source_stop_not_confirmed",
          sid: source.sid,
          message: `Task stop requested source stop for ${source.sid}, but no stopped source metadata was observed locally.`,
          recommendedFix: "Stop the source monitor directly if it is still active.",
        })
      }
    }
  }
  snapshotMonitorTaskSources(taskId)
  transcribeTaskSpeechAudio(taskId)
  return readMonitorTaskMeta(taskId) || task
}

// recover the sid of a live monitor session bound to this task
// by scanning session metas. Used when a slow/garbled start RPC response did not
// carry the sid (so the CLI can still attach instead of leaving an empty
// envelope). Returns the newest matching session.
export function findLatestSessionSidForTask(taskId: string): string | undefined {
  let best: { sid: string; startedAt: number } | undefined
  let entries: string[]
  try {
    entries = readdirSync(MONITOR_SESSIONS_DIR)
  } catch {
    return undefined
  }
  for (const sid of entries) {
    const meta = readSessionMeta(sid) as ({ taskId?: string; startedAt?: number } | null)
    if (!meta || meta.taskId !== taskId) continue
    const startedAt = typeof meta.startedAt === "number" ? meta.startedAt : 0
    if (!best || startedAt > best.startedAt) best = { sid, startedAt }
  }
  return best?.sid
}

// offline transcription hook. The bridge writes speech.caf when
// live Speech-Recognition was unavailable. This is the integration point that
// turns that audio into transcript rows. The default build ships the interface
// + detection; the concrete engine (Whisper, etc.) is selected at packaging
// time (PRD open question). When a source has captured audio but no live
// transcript and no engine is configured, we record an actionable diagnostic
// rather than silently leaving the audio untranscribed.
export function transcribeTaskSpeechAudio(taskId: string): { audioFound: number; alreadyTranscribed: number } {
  const task = readMonitorTaskMeta(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  let audioFound = 0
  let alreadyTranscribed = 0
  for (const source of task.sourceSessions) {
    const roots = [
      source.sourceSnapshotRoot,
      source.sourceArtifactRoot,
      source.originalSourceArtifactRoot,
      getSessionDir(source.sid),
    ].filter((r): r is string => typeof r === "string" && r.length > 0)
    const cafPath = roots.map((r) => join(r, "speech.caf")).find((p) => existsSync(p))
    if (!cafPath) continue
    audioFound++
    const hasLiveSpeech = readTaskSourceEvents(source).some((e) => e.event === "speech_segment")
    if (hasLiveSpeech) {
      alreadyTranscribed++
      continue
    }
    appendMonitorTaskDiagnostic(taskId, {
      severity: "warning",
      code: "speech_transcription_pending",
      sid: source.sid,
      message: `Captured offline audio (${cafPath}) has no live transcript; configure an offline speech engine to transcribe it.`,
      recommendedFix: "Grant live ASR with 'interceptor macos trust speech --prompt' and re-capture, or wire an offline transcription engine.",
    })
  }
  return { audioFound, alreadyTranscribed }
}

// the `monitor repair` operation the codebase has long advertised
// in recommendedFix strings. Recovers any live-but-unattached sessions for the
// task, durably snapshots all sources, runs the offline-transcription hook, then
// regenerates the timeline/transcript/segments and re-grades.
export function repairMonitorTask(
  taskId: string,
  options: { snapshotSources?: boolean; regenerate?: boolean } = {}
): { manifest: MonitorTaskSourceManifestEntry[]; report: MonitorTaskCaptureQualityReport; attached: string[] } {
  const task = readMonitorTaskMeta(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)

  // 1. Recover + attach live sessions that name this task but never registered.
  const attached: string[] = []
  const knownSids = new Set(task.sourceSessions.map((s) => s.sid))
  let entries: string[] = []
  try {
    entries = readdirSync(MONITOR_SESSIONS_DIR)
  } catch {
    entries = []
  }
  for (const sid of entries) {
    if (knownSids.has(sid)) continue
    const meta = readSessionMeta(sid) as ({ taskId?: string; surface?: MonitorTaskSurface } | null)
    if (!meta || meta.taskId !== taskId) continue
    try {
      attachMonitorTaskSource(taskId, sid, { surface: meta.surface })
      attached.push(sid)
    } catch {
      /* already attached to another active task, or no artifacts — skip */
    }
  }

  // 2. Snapshot (default), transcribe offline audio, regenerate, re-grade.
  const manifest = snapshotMonitorTaskSources(taskId)
  transcribeTaskSpeechAudio(taskId)
  if (options.regenerate !== false) {
    synthesizeMonitorTaskTranscript(taskId)
  }
  const report = generateMonitorTaskCaptureQuality(taskId)
  return { manifest, report, attached }
}

function stableId(prefix: string, parts: unknown[]): string {
  const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16)
  return `${prefix}-${hash}`
}

function timestampForEvent(event: MonitorEvent, fallback: number): { timestamp: number; confidence: TaskTimelineEntry["orderConfidence"] } {
  if (typeof event.t === "number") return { timestamp: event.t, confidence: "high" }
  if (typeof event.timestamp === "string") {
    const parsed = Date.parse(event.timestamp)
    if (Number.isFinite(parsed)) return { timestamp: parsed, confidence: "medium" }
  }
  return { timestamp: fallback, confidence: "low" }
}

function inferActor(event: MonitorEvent): MonitorTaskActorKind {
  if (event.actor === "human" || event.actor === "agent" || event.actor === "system" || event.actor === "verifier" || event.actor === "guard") {
    return event.actor
  }
  if (event.tr === false) return "agent"
  const kind = event.event || ""
  if (["click", "dblclick", "rclick", "input", "change", "submit", "key", "scroll", "copy", "paste"].includes(kind)) return "human"
  return "system"
}

function summarizeSourceEvent(event: MonitorEvent, surface: MonitorTaskSurface): string {
  const kind = event.event || "unknown"
  if (kind === "mon_start") return `Started ${surface} monitor session.`
  if (kind === "mon_stop") return `Stopped ${surface} monitor session.`
  if (kind === "click" || kind === "dblclick" || kind === "rclick") {
    const label = typeof event.n === "string" && event.n ? ` "${event.n}"` : ""
    const role = typeof event.r === "string" && event.r ? ` ${event.r}` : ""
    return `${inferActor(event)} ${kind === "click" ? "clicked" : kind}${role}${label}.`
  }
  if (kind === "input" || kind === "change") {
    const label = typeof event.n === "string" && event.n ? ` "${event.n}"` : " a field"
    return `${inferActor(event)} updated${label}.`
  }
  if (kind === "key") return `${inferActor(event)} pressed ${typeof event.kc === "string" ? event.kc : "a key"}.`
  if (kind === "nav") return `Navigation changed to ${typeof event.u === "string" ? event.u : "a new location"}.`
  if (kind === "frontmost") return `Frontmost app changed to ${typeof event.app === "string" ? event.app : "an app"}.`
  if (kind === "window_focus") return `Focused ${typeof event.app === "string" ? event.app : "an app"} window.`
  if (kind === "clipboard") return "Clipboard changed."
  if (kind === "file_change") return `File changed${typeof event.path === "string" ? `: ${event.path}` : ""}.`
  if (kind === "fetch" || kind === "xhr") return `${String(kind).toUpperCase()} ${typeof event.m === "string" ? event.m : "GET"} ${typeof event.u === "string" ? event.u : ""}.`
  return `${surface} event: ${kind}.`
}

function looksSensitiveText(label: unknown, value: string): boolean {
  const labelText = typeof label === "string" ? label.toLowerCase() : ""
  const valueText = value.toLowerCase()
  if (["password", "passcode", "token", "secret", "api key", "apikey", "card", "cvv", "ssn"].some((term) => labelText.includes(term) || valueText.includes(term))) return true
  if (/\b(?:sk|pk|rk|ghp|gho|ghu|github_pat)_[a-z0-9_]{12,}/i.test(value)) return true
  if (/\b(?:\d[ -]?){13,19}\b/.test(value)) return true
  return false
}

function textPreview(value: string, label?: unknown): string {
  if (looksSensitiveText(label, value)) return "[redacted]"
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact
}

function payloadForTimeline(event: MonitorEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const key of ["event", "r", "n", "u", "url", "m", "st", "app", "bundleId", "rootApp", "rootBundleId", "path", "reason", "tr", "kc"]) {
    const value = event[key]
    if (value !== undefined) payload[key] = value
  }
  if (typeof event.v === "string") {
    payload.valuePreview = textPreview(event.v, event.n)
    payload.valueLength = event.v.length
  }
  return payload
}

function getTaskSourceEventsPath(source: MonitorTaskSourceSession): string {
  const root = source.sourceSnapshotRoot || source.sourceArtifactRoot || getSessionDir(source.sid)
  return sourceArtifactPath(root, "events")
}

function getTaskSourceOriginalEventsPath(source: MonitorTaskSourceSession): string {
  const root = source.originalSourceArtifactRoot || getSessionDir(source.sid)
  return sourceArtifactPath(root, "events")
}

function readTaskSourceEvents(source: MonitorTaskSourceSession): MonitorEvent[] {
  const path = getTaskSourceEventsPath(source)
  if (existsSync(path)) return readJsonl<MonitorEvent>(path)
  return readSessionEvents(source.sid)
}

const DEFAULT_PRELUDE_MS = 10_000
const DEFAULT_EPILOGUE_MS = 30_000

function classifyTimelineBoundary(task: MonitorTaskMeta, timestamp: number): { boundary: TaskTimelineBoundary; reason?: string } {
  if (timestamp < task.startedAt) {
    if (task.startedAt - timestamp <= DEFAULT_PRELUDE_MS) return { boundary: "prelude", reason: "source event occurred during attach/start prelude" }
    return { boundary: "out_of_bounds", reason: "source event occurred before the task prelude window" }
  }
  if (task.endedAt && timestamp > task.endedAt) {
    if (timestamp - task.endedAt <= DEFAULT_EPILOGUE_MS) return { boundary: "epilogue", reason: "source event occurred during stop/export epilogue" }
    return { boundary: "out_of_bounds", reason: "source event occurred after the task epilogue window" }
  }
  return { boundary: "active" }
}

export function buildMonitorTaskTimeline(taskId: string): TaskTimelineEntry[] {
  const task = readMonitorTaskMeta(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  validateMonitorTaskSourceBindings(taskId)
  const entries: TaskTimelineEntry[] = []
  let fallbackTime = task.startedAt

  for (const source of task.sourceSessions) {
    const events = readTaskSourceEvents(source)
    const eventPath = getTaskSourceEventsPath(source)
    const originalEventPath = getTaskSourceOriginalEventsPath(source)
    if (events.length === 0) {
      const boundary = classifyTimelineBoundary(task, fallbackTime)
      entries.push({
        version: 1,
        taskId,
        entryId: stableId("tl", [taskId, source.sid, "missing"]),
        timestamp: fallbackTime++,
        orderConfidence: "low",
        sid: source.sid,
        surface: source.surface,
        sourceEventKind: "source.missing",
        actor: "system",
        boundary: boundary.boundary,
        ...(boundary.reason ? { boundaryReason: boundary.reason } : {}),
        summary: `Source artifacts missing for ${source.surface} session ${source.sid}.`,
        sourceRef: {
          sid: source.sid,
          surface: source.surface,
          eventPath,
          ...(originalEventPath !== eventPath ? { originalEventPath } : {}),
        },
        payload: { missing: true },
      })
      continue
    }

    events.forEach((event, idx) => {
      const time = timestampForEvent(event, fallbackTime++)
      const sourceSeq = typeof event.s === "number" ? event.s : idx
      const boundary = classifyTimelineBoundary(task, time.timestamp)
      entries.push({
        version: 1,
        taskId,
        entryId: stableId("tl", [taskId, source.sid, sourceSeq, event.event, idx]),
        timestamp: time.timestamp,
        orderConfidence: time.confidence,
        sid: source.sid,
        surface: source.surface,
        sourceEventKind: event.event || "unknown",
        sourceSeq,
        actor: inferActor(event),
        boundary: boundary.boundary,
        ...(boundary.reason ? { boundaryReason: boundary.reason } : {}),
        summary: summarizeSourceEvent(event, source.surface),
        sourceRef: {
          sid: source.sid,
          surface: source.surface,
          eventSeq: sourceSeq,
          eventPath,
          ...(originalEventPath !== eventPath ? { originalEventPath } : {}),
        },
        payload: payloadForTimeline(event),
      })
    })
  }

  entries.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
    if (a.sid !== b.sid) return a.sid.localeCompare(b.sid)
    return (a.sourceSeq ?? 0) - (b.sourceSeq ?? 0)
  })
  ensureMonitorTaskDir(taskId)
  writeJsonl(getMonitorTaskTimelinePath(taskId), entries)
  writeFileSync(getMonitorTaskTimelineIndexPath(taskId), JSON.stringify({
    version: 1,
    taskId,
    createdAt: Date.now(),
    entries: entries.length,
    boundaryCounts: {
      prelude: entries.filter((entry) => entry.boundary === "prelude").length,
      active: entries.filter((entry) => entry.boundary === "active").length,
      epilogue: entries.filter((entry) => entry.boundary === "epilogue").length,
      out_of_bounds: entries.filter((entry) => entry.boundary === "out_of_bounds").length,
    },
  }, null, 2) + "\n")
  updateMonitorTaskMeta(taskId, (current) => ({
    ...current,
    transcript: {
      ...current.transcript,
      evidenceTimelinePath: getMonitorTaskTimelinePath(taskId),
    },
  }))
  appendMonitorTaskEvent(taskId, "timeline.created", { actor: "system", payload: { entries: entries.length } })
  return entries
}

export class TaskTimelineMerger {
  merge(taskId: string): TaskTimelineEntry[] {
    return buildMonitorTaskTimeline(taskId)
  }
}

export class HeuristicSemanticTranscriptSynthesizer implements SemanticTranscriptSynthesizer {
  readonly name = "heuristic-semantic-transcript-synthesizer"

  synthesize(task: MonitorTaskMeta, timeline: TaskTimelineEntry[]): SemanticTranscriptEntry[] {
    return timeline
      .filter((entry) => entry.sourceEventKind !== "mut")
      .map((entry) => ({
        version: 1,
        taskId: task.taskId,
        entryId: stableId("tr", [entry.taskId, entry.entryId]),
        timestampStart: entry.timestamp,
        timestampEnd: entry.timestamp,
        actor: entry.actor,
        summary: entry.summary,
        intent: inferIntent(entry),
        surfaces: [entry.surface],
        sourceRefs: [{ ...entry.sourceRef }],
        confidence: entry.orderConfidence === "low" ? "low" : "medium",
        ...(entry.orderConfidence === "low" ? { uncertainty: "Source timestamp or artifact was incomplete." } : {}),
        privacyLabels: [],
      }))
  }
}

function inferIntent(entry: TaskTimelineEntry): string | undefined {
  if (entry.sourceEventKind === "mon_start") return "start_capture"
  if (entry.sourceEventKind === "mon_stop") return "stop_capture"
  if (["click", "dblclick", "rclick", "input", "change", "key", "submit"].includes(entry.sourceEventKind)) return "user_interaction"
  if (["fetch", "xhr", "sse"].includes(entry.sourceEventKind) || entry.sourceEventKind.startsWith("ws_")) return "app_communication"
  if (entry.sourceEventKind === "nav") return "navigation"
  if (entry.surface === "macos") return "native_app_context"
  return undefined
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function originOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

function hostOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function isSensitiveUrl(value: unknown): boolean {
  const raw = typeof value === "string" ? value.toLowerCase() : ""
  if (!raw) return false
  return [
    "stripe",
    "paypal",
    "billing",
    "invoice",
    "payment",
    "bank",
    "password",
    "credential",
    "keychain",
    "login",
    "auth",
    "settings",
    "account",
  ].some((term) => raw.includes(term))
}

function classifyUrlForTask(task: MonitorTaskMeta, url: unknown): "same_origin" | "same_site" | "external" | "sensitive" | "unknown" {
  if (typeof url !== "string") return "unknown"
  if (isSensitiveUrl(url)) return "sensitive"
  const host = hostOf(url)
  const origin = originOf(url)
  if (!host || !origin) return "unknown"
  const sourceOrigins = task.sourceSessions
    .map((source) => originOf(readSessionMeta(source.sid)?.url))
    .filter((item): item is string => Boolean(item))
  if (sourceOrigins.includes(origin)) return "same_origin"
  const hostParts = host.split(".").slice(-2).join(".")
  const sourceSites = sourceOrigins
    .map((item) => hostOf(item))
    .filter((item): item is string => Boolean(item))
    .map((item) => item.split(".").slice(-2).join("."))
  if (sourceSites.includes(hostParts)) return "same_site"
  return "external"
}

function sourceForTimelineEntry(task: MonitorTaskMeta, entry: TaskTimelineEntry): MonitorTaskSourceSession | undefined {
  return task.sourceSessions.find((source) => source.sid === entry.sid)
}

function appNameForEntry(task: MonitorTaskMeta, entry: TaskTimelineEntry): string | undefined {
  return typeof entry.payload?.app === "string" ? entry.payload.app :
    typeof entry.payload?.rootApp === "string" ? entry.payload.rootApp :
      sourceForTimelineEntry(task, entry)?.rootApp
}

function bundleIdForEntry(task: MonitorTaskMeta, entry: TaskTimelineEntry): string | undefined {
  return typeof entry.payload?.bundleId === "string" ? entry.payload.bundleId :
    typeof entry.payload?.rootBundleId === "string" ? entry.payload.rootBundleId :
      sourceForTimelineEntry(task, entry)?.rootBundleId
}

function isCodexEntry(task: MonitorTaskMeta, entry: TaskTimelineEntry): boolean {
  const app = appNameForEntry(task, entry)?.toLowerCase()
  const bundleId = bundleIdForEntry(task, entry)?.toLowerCase()
  return app === "codex" || bundleId === "com.openai.codex"
}

function isContextSelectionEntry(entry: TaskTimelineEntry): boolean {
  return entry.sourceEventKind === "title_change" &&
    typeof entry.payload?.n === "string" &&
    Boolean(entry.payload.n.trim()) &&
    String(entry.payload?.r || "").toLowerCase().includes("popup")
}

function isSuppressedTimelineNoise(entry: TaskTimelineEntry): boolean {
  const kind = entry.sourceEventKind
  if (isContextSelectionEntry(entry)) return false
  if (kind === "title_change") return true
  return [
    "selection",
    "selection_rows",
    "mods",
    "focus",
    "blur",
    "mouseup",
    "move",
    "ax_create",
    "ax_destroy",
    "ax_other",
    "layout_change",
  ].includes(kind)
}

function groupKindForEntry(entry: TaskTimelineEntry): string {
  if (["mon_start", "mon_attach", "mon_detach", "mon_stop", "mon_pause", "mon_resume"].includes(entry.sourceEventKind)) return "lifecycle"
  if (isContextSelectionEntry(entry)) return "context_selection"
  if (entry.sourceEventKind === "scroll") return "scroll"
  if (entry.sourceEventKind === "key" && entry.payload?.kc === "\r") return "submit"
  if (["key", "input", "change", "paste", "copy"].includes(entry.sourceEventKind)) return "text"
  if (["click", "dblclick", "rclick", "menu_select"].includes(entry.sourceEventKind)) return "control"
  if (["frontmost", "app_deactivate", "ax_app_activated", "ax_app_deactivated", "window_focus", "app_launch", "app_terminate", "app_hide", "app_unhide"].includes(entry.sourceEventKind)) return "app_context"
  if (entry.sourceEventKind === "nav" || entry.sourceEventKind === "reload") return "navigation"
  if (["fetch", "xhr", "sse", "ws_opening", "ws_open", "ws_send", "ws_message", "ws_error", "ws_close", "beacon", "broadcast_send", "broadcast_message"].includes(entry.sourceEventKind)) return "network"
  if (entry.sourceEventKind === "clipboard") return "clipboard"
  if (entry.sourceEventKind === "file_change") return "file"
  if (entry.sourceEventKind === "ocr_text" || entry.sourceEventKind === "frame") return "vision"
  if (entry.sourceEventKind === "speech_segment") return "speech"
  return "observed_event"
}

function segmentMergeGapMs(groupKind: string): number {
  if (groupKind === "text") return 30_000
  if (groupKind === "scroll") return 10_000
  if (groupKind === "app_context") return 15_000
  if (groupKind === "context_selection") return 5_000
  if (groupKind === "network") return 2_500
  if (groupKind === "lifecycle") return 1_500
  return 1_500
}

function finalValuePreview(entries: TaskTimelineEntry[]): string | undefined {
  for (const entry of [...entries].reverse()) {
    if (typeof entry.payload?.valuePreview === "string" && entry.payload.valuePreview) return entry.payload.valuePreview
  }
  return undefined
}

function finalValueLength(entries: TaskTimelineEntry[]): number | undefined {
  for (const entry of [...entries].reverse()) {
    if (typeof entry.payload?.valueLength === "number") return entry.payload.valueLength
  }
  return undefined
}

function contextSelectionLabel(entries: TaskTimelineEntry[]): string | undefined {
  for (const entry of [...entries].reverse()) {
    if (typeof entry.payload?.n === "string" && entry.payload.n.trim()) return entry.payload.n.trim()
  }
  return undefined
}

function segmentTitleForGroup(task: MonitorTaskMeta, groupKind: string, entries: TaskTimelineEntry[]): string {
  const codex = entries.some((entry) => isCodexEntry(task, entry))
  if (groupKind === "lifecycle") return "Captured monitor lifecycle event"
  if (groupKind === "context_selection") return "Selected native app context"
  if (groupKind === "scroll") return "Scrolled within the current surface"
  if (groupKind === "text") return codex ? "Drafted or edited Codex prompt" : "Entered or edited text"
  if (groupKind === "submit") return codex ? "Submitted Codex prompt" : "Submitted prompt or form"
  if (groupKind === "app_context") return "Changed native app or window context"
  if (groupKind === "navigation") return "Navigated browser context"
  if (groupKind === "network") return "Observed app communication"
  if (groupKind === "clipboard") return "Used the clipboard"
  if (groupKind === "file") return "Changed a file"
  if (groupKind === "vision") return "Captured visual evidence"
  if (groupKind === "speech") return "Captured speech transcript"
  if (groupKind === "control") return codex ? "Interacted with Codex control" : "Interacted with a control"
  if (groupKind === "scroll") return "Scrolled within the current surface"
  return "Observed workflow event"
}

function segmentSummaryForGroup(task: MonitorTaskMeta, groupKind: string, entries: TaskTimelineEntry[]): string {
  const title = segmentTitleForGroup(task, groupKind, entries)
  if (groupKind === "text") {
    const preview = finalValuePreview(entries)
    const length = finalValueLength(entries)
    const lengthPart = typeof length === "number" ? ` Final captured value length: ${length} characters.` : ""
    const previewPart = preview ? ` Preview: "${preview}".` : ""
    return `${title} across ${entries.length} low-level text events.${lengthPart}${previewPart}`
  }
  if (groupKind === "submit") return `${title}.`
  if (groupKind === "context_selection") {
    const label = contextSelectionLabel(entries)
    return label ? `${title}: "${label}".` : `${title}.`
  }
  if (groupKind === "scroll") return `${title} (${entries.length} low-level scroll events).`
  if (groupKind === "network") return `${title} (${entries.length} network events).`
  if (entries.length === 1) return entries[0].summary
  return `${title} (${entries.length} low-level events).`
}

function inferSegmentIntent(groupKind: string, first: TaskTimelineEntry): string | undefined {
  if (groupKind === "text") return "compose_text"
  if (groupKind === "submit") return "submit_work_item"
  if (groupKind === "context_selection") return "select_context"
  if (groupKind === "control") return "user_interaction"
  if (groupKind === "scroll") return "review_surface"
  if (groupKind === "app_context") return "native_app_context"
  return inferIntent(first)
}

function shouldMergeSegment(last: TaskTimelineEntry[], next: TaskTimelineEntry): boolean {
  if (last.length === 0) return false
  const prev = last[last.length - 1]
  const prevKind = groupKindForEntry(prev)
  const nextKind = groupKindForEntry(next)
  if (prevKind !== nextKind) return false
  if (prev.sid !== next.sid) return false
  if (!["scroll", "text", "app_context", "context_selection", "network", "lifecycle"].includes(nextKind)) return false
  return next.timestamp - prev.timestamp <= segmentMergeGapMs(nextKind)
}

function segmentFromEntries(task: MonitorTaskMeta, entries: TaskTimelineEntry[], sequence: number): TeachableTranscriptSegment {
  const first = entries[0]
  const last = entries[entries.length - 1]
  const urls = entries.map((entry) => entry.payload?.u || entry.payload?.url).filter(Boolean)
  const urlClasses = urls.map((url) => classifyUrlForTask(task, url))
  const sensitive = urlClasses.includes("sensitive") || entries.some((entry) => isSensitiveUrl(entry.payload?.u || entry.payload?.url))
  const external = urlClasses.includes("external")
  const reviewRequired = sensitive || external
  const appRecords = entries.map((entry) => ({
    surface: entry.surface,
    app: appNameForEntry(task, entry),
    bundleId: bundleIdForEntry(task, entry),
    origin: originOf(entry.payload?.u || entry.payload?.url),
    urlClass: classifyUrlForTask(task, entry.payload?.u || entry.payload?.url),
  }))
  const sourceRefs = entries.map((entry) => ({ ...entry.sourceRef }))
  const groupKind = groupKindForEntry(first)
  const title = segmentTitleForGroup(task, groupKind, entries)
  const summary = segmentSummaryForGroup(task, groupKind, entries)
  const confidence: TeachableTranscriptSegment["confidence"] =
    entries.some((entry) => entry.orderConfidence === "low") ? "low" :
      reviewRequired || groupKind === "observed_event" ? "medium" : "high"
  const privacyLabels = unique([
    ...(sensitive ? ["sensitive_handoff"] : []),
    ...(external ? ["external_handoff"] : []),
  ])
  const diagnosticOnly = ["lifecycle", "app_context", "scroll", "observed_event"].includes(groupKind)
  return {
    version: 1,
    taskId: task.taskId,
    segmentId: stableId("seg", [task.taskId, entries.map((entry) => entry.entryId)]),
    sequence,
    timestampStart: first.timestamp,
    timestampEnd: last.timestamp,
    boundary: first.boundary === "out_of_bounds" ? "active" : first.boundary,
    actor: first.actor,
    surfaces: unique(entries.map((entry) => entry.surface)),
    apps: appRecords.filter((app, idx, arr) => idx === arr.findIndex((item) => JSON.stringify(item) === JSON.stringify(app))),
    title,
    summary,
    observedAction: ["control", "text", "submit", "navigation", "context_selection"].includes(groupKind) ? title : undefined,
    observedOutcome: entries.some((entry) => entry.sourceEventKind === "nav") ? "Browser navigation changed." : undefined,
    inferredIntent: inferSegmentIntent(groupKind, first),
    decisionPoint: reviewRequired,
    requiresHumanReview: reviewRequired,
    ...(reviewRequired ? { reviewReason: sensitive ? "Sensitive billing, payment, account, credential, or settings surface observed." : "External browser handoff requires confirmation before reuse." } : {}),
    sourceRefs,
    confidence,
    ...(confidence === "low" ? { uncertainty: "One or more source events had low ordering confidence." } : {}),
    privacyLabels,
    blueprintUse: sensitive ? "sensitive" : reviewRequired ? "needs_review" : diagnosticOnly || first.boundary === "epilogue" || first.boundary === "prelude" ? "diagnostic_only" : "eligible",
  }
}

export function buildTeachableTranscriptSegments(
  taskId: string,
  timelineInput?: TaskTimelineEntry[]
): TeachableTranscriptSegment[] {
  const task = readMonitorTaskMeta(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  const existingTimeline = timelineInput || readMonitorTaskTimeline(taskId)
  const timeline = (existingTimeline.length > 0 ? existingTimeline : buildMonitorTaskTimeline(taskId))
    .filter((entry) => entry.boundary !== "out_of_bounds")
    .filter((entry) => entry.sourceEventKind !== "mut")
    .filter((entry) => entry.boundary === "active")
    .filter((entry) => !isSuppressedTimelineNoise(entry))
  const groups: TaskTimelineEntry[][] = []
  for (const entry of timeline) {
    const last = groups[groups.length - 1]
    if (last && shouldMergeSegment(last, entry)) last.push(entry)
    else groups.push([entry])
  }
  const segments = groups
    .map((group, index) => segmentFromEntries(task, group, index))
  writeJsonl(getMonitorTaskTranscriptSegmentsPath(taskId), segments)
  return segments
}

export function validateSemanticTranscriptEntry(entry: SemanticTranscriptEntry): string[] {
  const errors: string[] = []
  if (entry.version !== 1) errors.push("version must be 1")
  if (!entry.taskId) errors.push("taskId is required")
  if (!entry.entryId) errors.push("entryId is required")
  if (!entry.summary) errors.push("summary is required")
  if (!Array.isArray(entry.sourceRefs) || entry.sourceRefs.length === 0) {
    errors.push("sourceRefs must contain at least one source reference")
  }
  for (const ref of entry.sourceRefs || []) {
    if (!ref.sid) errors.push("sourceRef.sid is required")
    if (ref.surface !== "browser" && ref.surface !== "macos") errors.push("sourceRef.surface must be browser or macos")
  }
  return errors
}

export function validateSemanticTranscript(entries: SemanticTranscriptEntry[]): void {
  const failures = entries.flatMap((entry) => validateSemanticTranscriptEntry(entry).map((error) => `${entry.entryId || "(missing-entry-id)"}: ${error}`))
  if (failures.length > 0) throw new Error(`semantic transcript validation failed: ${failures.join("; ")}`)
}

export class SemanticTranscriptValidator {
  validate(entries: SemanticTranscriptEntry[]): void {
    validateSemanticTranscript(entries)
  }
}

export function synthesizeMonitorTaskTranscript(
  taskId: string,
  synthesizer: SemanticTranscriptSynthesizer = new HeuristicSemanticTranscriptSynthesizer()
): SemanticTranscriptEntry[] {
  const task = readMonitorTaskMeta(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  const timeline = buildMonitorTaskTimeline(taskId)
  const entries = synthesizer.synthesize(task, timeline)
  try {
    validateSemanticTranscript(entries)
  } catch (err) {
    appendMonitorTaskEvent(taskId, "transcript.validation_failed", {
      actor: "system",
      payload: { error: (err as Error).message },
    })
    updateMonitorTaskMeta(taskId, (current) => ({
      ...current,
      transcript: { ...current.transcript, lastSynthesisStatus: "failed", lastSynthesisModel: synthesizer.name },
    }))
    throw err
  }
  writeJsonl(getMonitorTaskTranscriptPath(taskId), entries)
  const segments = buildTeachableTranscriptSegments(taskId, timeline)
  updateMonitorTaskMeta(taskId, (current) => ({
    ...current,
    transcript: {
      ...current.transcript,
      evidenceTimelinePath: getMonitorTaskTimelinePath(taskId),
      semanticTranscriptPath: getMonitorTaskTranscriptPath(taskId),
      lastSynthesizedAt: Date.now(),
      lastSynthesisModel: synthesizer.name,
      lastSynthesisStatus: entries.some((entry) => entry.confidence === "low") ? "partial" : "complete",
    },
  }))
  appendMonitorTaskEvent(taskId, "transcript.synthesized", {
    actor: "system",
    payload: { entries: entries.length, segments: segments.length, synthesizer: synthesizer.name },
  })
  generateMonitorTaskCaptureQuality(taskId)
  return entries
}

export function readMonitorTaskTimeline(taskId: string): TaskTimelineEntry[] {
  return readJsonl<TaskTimelineEntry>(getMonitorTaskTimelinePath(taskId))
}

export function readMonitorTaskTranscript(taskId: string): SemanticTranscriptEntry[] {
  return readJsonl<SemanticTranscriptEntry>(getMonitorTaskTranscriptPath(taskId))
}

export function readMonitorTaskTranscriptSegments(taskId: string): TeachableTranscriptSegment[] {
  return readJsonl<TeachableTranscriptSegment>(getMonitorTaskTranscriptSegmentsPath(taskId))
}

export function readMonitorTaskCaptureQuality(taskId: string): MonitorTaskCaptureQualityReport | null {
  const path = getMonitorTaskCaptureQualityPath(taskId)
  if (!existsSync(path)) return null
  return safeParse<MonitorTaskCaptureQualityReport>(readFileSync(path, "utf-8"))
}

function score(value: boolean): number {
  return value ? 1 : 0
}

export function generateMonitorTaskCaptureQuality(taskId: string): MonitorTaskCaptureQualityReport {
  const task = readMonitorTaskMeta(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  const timeline = readMonitorTaskTimeline(taskId)
  const transcript = readMonitorTaskTranscript(taskId)
  const segments = readMonitorTaskTranscriptSegments(taskId)
  const manifest = readMonitorTaskSourceManifest(taskId)
  const diagnostics = readMonitorTaskDiagnostics(taskId)
  const missingSourceRefs = transcript.filter((entry) => !entry.sourceRefs || entry.sourceRefs.length === 0).length +
    segments.filter((entry) => !entry.sourceRefs || entry.sourceRefs.length === 0).length
  const tmpBackedSourceRefs = [...transcript.flatMap((entry) => entry.sourceRefs), ...segments.flatMap((entry) => entry.sourceRefs)]
    .filter((ref) => typeof ref.eventPath === "string" && ref.eventPath.startsWith("/tmp/")).length
  const requiredManifest = manifest.filter((entry) => entry.artifactKind === "session" || entry.artifactKind === "events")
  const durabilityOk = task.sourceSessions.length > 0 &&
    task.sourceSessions.every((source) => source.sourceSnapshotStatus === "complete" || source.sourceSnapshotStatus === "partial") &&
    requiredManifest.filter((entry) => entry.status === "present").length >= task.sourceSessions.length * 2
  const metadataOk = task.sourceSessions.every((source) => {
    const snapshotMetaPath = source.sourceSnapshotRoot ? sourceArtifactPath(source.sourceSnapshotRoot, "session") : undefined
    const snapshotMeta = snapshotMetaPath && existsSync(snapshotMetaPath) ? safeParse<MonitorSessionMeta>(readFileSync(snapshotMetaPath, "utf-8")) : null
    const liveMeta = readSessionMeta(source.sid)
    const bindingPath = sourceArtifactPath(source.sourceSnapshotRoot || getMonitorTaskSourceSnapshotDir(taskId, source.sid), "binding")
    const bindingOk = existsSync(bindingPath)
    const surfaceOk = snapshotMeta?.surface === source.surface || liveMeta?.surface === source.surface
    const taskBindingOk = snapshotMeta?.taskId === taskId || liveMeta?.taskId === taskId || bindingOk
    const snapshotFinalizedOk = !snapshotMeta || (
      snapshotMeta.status === "stopped" &&
      typeof snapshotMeta.endedAt === "number" &&
      typeof snapshotMeta.counts?.evt === "number"
    )
    return Boolean(source.surface && surfaceOk && taskBindingOk && snapshotFinalizedOk)
  })
  const outOfBoundsEvents = timeline.filter((entry) => entry.boundary === "out_of_bounds").length
  const reviewRequiredSegments = segments.filter((entry) => entry.requiresHumanReview).length
  const sensitiveHandoffs = segments.filter((entry) => entry.privacyLabels.includes("sensitive_handoff")).length
  const macosRows = timeline.filter((entry) => entry.surface === "macos").length
  const browserRows = timeline.filter((entry) => entry.surface === "browser").length
  const rawTitleSegments = segments.filter((segment) => /^(browser|macos) event:/i.test(segment.title) || /^(browser|macos) event:/i.test(segment.summary)).length
  const compressionRatio = transcript.length === 0 ? 1 : segments.length / Math.max(transcript.length, 1)
  const activeRows = timeline.filter((entry) => entry.boundary === "active").length
  const humanScaleLimit = Math.max(20, Math.min(150, Math.ceil(Math.max(activeRows, 1) * 0.05)))
  const ratioOk = transcript.length < 40 ? segments.length <= transcript.length : compressionRatio <= 0.25
  const humanScaleOk = segments.length > 0 && segments.length <= humanScaleLimit
  const semanticTitlesOk = rawTitleSegments === 0
  const compressionOk = segments.length > 0 && ratioOk && humanScaleOk && semanticTitlesOk
  const boundaryOk = outOfBoundsEvents === 0
  const evidenceOk = missingSourceRefs === 0
  const scopeOk = reviewRequiredSegments === 0
  const privacyOk = sensitiveHandoffs === 0
  const blueprintOk = durabilityOk && metadataOk && boundaryOk && evidenceOk && compressionOk && scopeOk && privacyOk
  const findings: MonitorTaskCaptureQualityReport["findings"] = []

  if (!durabilityOk) findings.push({ severity: "blocker", code: "source_durability_incomplete", message: "One or more task sources are not durably snapshotted under the task root.", recommendedFix: "Run interceptor monitor repair --task <taskId> --snapshot-sources while source artifacts still exist." })
  if (!metadataOk) findings.push({ severity: "error", code: "source_metadata_incomplete", message: "One or more task-attached sources lacks complete taskId or surface metadata." })
  if (tmpBackedSourceRefs > 0) findings.push({ severity: "warning", code: "tmp_backed_source_refs", message: `${tmpBackedSourceRefs} source references still point to /tmp.`, recommendedFix: "Regenerate the timeline/transcript after source snapshots complete." })
  if (outOfBoundsEvents > 0) findings.push({ severity: "warning", code: "out_of_bounds_events", message: `${outOfBoundsEvents} timeline events are outside the task boundary window.` })
  if (reviewRequiredSegments > 0) findings.push({ severity: "warning", code: "review_required_segments", message: `${reviewRequiredSegments} transcript segments require human review before blueprint compilation.` })
  if (sensitiveHandoffs > 0) findings.push({ severity: "error", code: "sensitive_handoff", message: `${sensitiveHandoffs} sensitive handoff segments were detected.` })
  if (browserRows > 0 && macosRows / browserRows > 5) findings.push({ severity: "warning", code: "macos_noise_high", message: `macOS event volume is high relative to browser evidence (${macosRows}:${browserRows}).`, recommendedFix: "Use transcript segments for review and tighten macOS app scope for future captures." })
  if (!ratioOk) findings.push({ severity: "warning", code: "weak_transcript_compression", message: `Teachable transcript compression is too weak (${segments.length} segments from ${transcript.length} transcript rows).`, recommendedFix: "Regenerate with the reducer-backed segmenter or add an app-specific semantic adapter." })
  if (!humanScaleOk) findings.push({ severity: "warning", code: "transcript_not_human_scale", message: `Teachable transcript has ${segments.length} segments; expected at most ${humanScaleLimit} for this capture size.`, recommendedFix: "Suppress low-value event kinds and group long text-edit sessions before blueprint compilation." })
  if (!semanticTitlesOk) findings.push({ severity: "warning", code: "semantic_segments_too_raw", message: `${rawTitleSegments} teachable segments still use raw event-style titles.`, recommendedFix: "Map raw monitor event groups into workflow-level titles before marking the task excellent." })

  // capture-specific findings sourced from raw source events so the
  // operator sees *why* a transcript is thin (permission vs scope vs geometry).
  let speechDenied = false
  let speechSegmentRows = 0
  let degenerateFrames = 0
  for (const source of task.sourceSessions) {
    for (const e of readTaskSourceEvents(source)) {
      if (e.event === "speech_segment") speechSegmentRows++
      else if (e.event === "speech_unavailable") {
        const reason = typeof (e as { reason?: unknown }).reason === "string" ? (e as { reason: string }).reason : ""
        if (/authorization\s+(1|2)|denied|restricted|missing NSSpeechRecognitionUsageDescription/i.test(reason)) speechDenied = true
      } else if (e.event === "frame") {
        const w = Number((e as { w?: unknown }).w) || 0
        const h = Number((e as { h?: unknown }).h) || 0
        if (w > 0 && h > 0 && Math.max(w, h) / Math.max(1, Math.min(w, h)) > 50) degenerateFrames++
      }
    }
  }
  if (speechDenied && speechSegmentRows === 0) {
    findings.push({
      severity: "warning",
      code: "speech_permission_denied",
      message: "Speech Recognition was unavailable (TCC denied or usage key missing); no live transcript was produced.",
      recommendedFix: "Run interceptor macos trust speech --prompt, then re-run capture (or use --speech-mode offline to capture audio for offline transcription).",
    })
  }
  if (degenerateFrames > 0) {
    findings.push({
      severity: "warning",
      code: "frame_geometry_degenerate",
      message: `${degenerateFrames} captured frames have implausible geometry (extreme aspect ratio — the SCStream sliver bug).`,
      recommendedFix: "Re-capture; the pixel-scale + scalesToFit geometry fix resolves sliver frames.",
    })
  }

  for (const diagnostic of diagnostics.filter((item) => item.severity === "error" || item.severity === "blocker")) {
    findings.push({ severity: diagnostic.severity, code: diagnostic.code, message: diagnostic.message, evidenceRefs: diagnostic.evidenceRefs, recommendedFix: diagnostic.recommendedFix })
  }

  const report: MonitorTaskCaptureQualityReport = {
    version: 1,
    taskId,
    createdAt: Date.now(),
    status: blueprintOk ? "excellent" : durabilityOk && metadataOk && evidenceOk ? "usable_after_review" : durabilityOk ? "diagnostic_only" : "not_usable",
    scores: {
      sourceDurability: score(durabilityOk),
      sourceMetadataCompleteness: score(metadataOk),
      lifecycleBoundaryCleanliness: score(boundaryOk),
      scopeDiscipline: score(scopeOk),
      transcriptCompression: score(compressionOk),
      evidenceCoverage: score(evidenceOk),
      privacyReadiness: score(privacyOk),
      blueprintReadiness: score(blueprintOk),
    },
    counts: {
      sourceCount: task.sourceSessions.length,
      taskEventRows: readMonitorTaskEvents(taskId).length,
      timelineRows: timeline.length,
      transcriptRows: transcript.length,
      segmentRows: segments.length,
      rawTitleSegments,
      compressionRatioPermille: Math.round(compressionRatio * 1000),
      missingSourceRefs,
      tmpBackedSourceRefs,
      preludeEvents: timeline.filter((entry) => entry.boundary === "prelude").length,
      activeEvents: timeline.filter((entry) => entry.boundary === "active").length,
      epilogueEvents: timeline.filter((entry) => entry.boundary === "epilogue").length,
      outOfBoundsEvents,
      sensitiveHandoffs,
      reviewRequiredSegments,
    },
    findings,
    gates: {
      reviewReady: durabilityOk && metadataOk && evidenceOk && segments.length > 0,
      reducerReady: durabilityOk && metadataOk && evidenceOk && boundaryOk,
      verifierAuthoringReady: durabilityOk && metadataOk && evidenceOk && segments.length > 0,
      blueprintCompilationReady: blueprintOk,
    },
  }
  writeFileSync(getMonitorTaskCaptureQualityPath(taskId), JSON.stringify(report, null, 2) + "\n")
  return report
}

export function renderMonitorTaskQualitySummary(taskId: string): string {
  const report = readMonitorTaskCaptureQuality(taskId) || generateMonitorTaskCaptureQuality(taskId)
  const findings = report.findings.filter((finding) => finding.severity !== "info").slice(0, 3)
  const next = report.gates.blueprintCompilationReady ? "Next: compile a draft blueprint." :
    report.gates.reviewReady ? "Next: review required transcript segments before blueprint compilation." :
      "Next: repair capture diagnostics before reuse."
  return [
    `capture quality: ${report.status}`,
    `  source durability: ${report.scores.sourceDurability}`,
    `  transcript segments: ${report.counts.segmentRows}`,
    `  review-required segments: ${report.counts.reviewRequiredSegments}`,
    `  blueprint-ready: ${report.gates.blueprintCompilationReady ? "yes" : "no"}`,
    ...findings.map((finding) => `  ${finding.severity}: ${finding.code} - ${finding.message}`),
    `  ${next}`,
  ].join("\n")
}

export function assertMonitorTaskBlueprintReady(taskId: string, options: { forceDiagnostic?: boolean } = {}): MonitorTaskCaptureQualityReport {
  const report = readMonitorTaskCaptureQuality(taskId) || generateMonitorTaskCaptureQuality(taskId)
  if (!report.gates.blueprintCompilationReady && !options.forceDiagnostic) {
    throw new Error(`task ${taskId} is not blueprint-ready; review or repair required before compilation`)
  }
  return report
}

export function monitorTaskExportObject(taskId: string): Record<string, unknown> {
  if (!readMonitorTaskMeta(taskId)) throw new Error(`task not found: ${taskId}`)
  const existingTimeline = readMonitorTaskTimeline(taskId)
  const timeline = existingTimeline.length > 0 ? existingTimeline : buildMonitorTaskTimeline(taskId)
  const task = readMonitorTaskMeta(taskId)!
  return {
    task,
    sources: readMonitorTaskSourceEvents(taskId),
    events: readMonitorTaskEvents(taskId),
    timeline,
    transcript: readMonitorTaskTranscript(taskId),
    transcriptSegments: readMonitorTaskTranscriptSegments(taskId),
    sourceManifest: readMonitorTaskSourceManifest(taskId),
    diagnostics: readMonitorTaskDiagnostics(taskId),
    captureQuality: readMonitorTaskCaptureQuality(taskId),
  }
}

export function renderMonitorTaskStatus(taskId: string): string {
  const task = readMonitorTaskMeta(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  const started = new Date(task.startedAt).toISOString().replace("T", " ").slice(0, 19)
  const lines = [
    `task ${task.taskId}`,
    `  status: ${task.status}`,
    `  mode: ${task.mode}`,
    `  started: ${started}`,
    `  instruction: ${task.instruction}`,
    `  sources: ${task.sourceSessions.length}`,
  ]
  for (const source of task.sourceSessions) {
    lines.push(`    ${source.surface} ${source.sid} ${source.rootApp || source.rootBundleId || source.rootTabId || ""}`.trimEnd())
  }
  return lines.join("\n")
}
