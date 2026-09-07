import { IK_SINK_TT_POLICY, SINK_TT_POLICY_NAME } from "../../inject-keys"
import { runWithCspStripBypass } from "./evaluate"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

type ByteSource = {
  url: string
  size: number
  mime: string
  kind: string
  created: boolean
}

const DEFAULT_CHUNK_SIZE = 1024 * 1024

async function executeNormalize(
  tabId: number,
  world: "MAIN" | "ISOLATED",
  code: string
): Promise<ActionResult> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    args: [code, IK_SINK_TT_POLICY, SINK_TT_POLICY_NAME],
    func: async (sourceCode: string, ttKey: string, ttName: string) => {
      const TT = Symbol.for(ttKey)
      async function normalize(value: unknown): Promise<{
        url: string
        size: number
        mime: string
        kind: string
        created: boolean
      }> {
        if (value && typeof (value as Promise<unknown>).then === "function") {
          value = await value
        }

        if (value instanceof Blob) {
          return {
            url: URL.createObjectURL(value),
            size: value.size,
            mime: value.type || "application/octet-stream",
            kind: value instanceof File ? "file" : "blob",
            created: true
          }
        }

        if (value instanceof ArrayBuffer) {
          const blob = new Blob([value], { type: "application/octet-stream" })
          return {
            url: URL.createObjectURL(blob),
            size: blob.size,
            mime: blob.type,
            kind: "arraybuffer",
            created: true
          }
        }

        if (ArrayBuffer.isView(value)) {
          const source = value as ArrayBufferView
          const bytes = new Uint8Array(source.byteLength)
          bytes.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength))
          const blob = new Blob([bytes.buffer], { type: "application/octet-stream" })
          return {
            url: URL.createObjectURL(blob),
            size: blob.size,
            mime: blob.type,
            kind: "arraybuffer-view",
            created: true
          }
        }

        if (typeof value === "string") {
          if (value.startsWith("blob:")) {
            return {
              url: value,
              size: -1,
              mime: "application/octet-stream",
              kind: "blob-url",
              created: false
            }
          }
          const blob = new Blob([value], { type: "text/plain;charset=utf-8" })
          return {
            url: URL.createObjectURL(blob),
            size: blob.size,
            mime: blob.type,
            kind: "text",
            created: true
          }
        }

        if (value && typeof value === "object") {
          const record = value as { url?: unknown; blobUrl?: unknown; href?: unknown; type?: unknown; size?: unknown }
          const candidate = record.url ?? record.blobUrl ?? record.href
          if (typeof candidate === "string" && candidate.startsWith("blob:")) {
            return {
              url: candidate,
              size: typeof record.size === "number" ? record.size : -1,
              mime: typeof record.type === "string" ? record.type : "application/octet-stream",
              kind: "blob-url-object",
              created: false
            }
          }
        }

        throw new Error("expression must return Blob, File, ArrayBuffer, typed array, string, or blob: URL")
      }

      try {
        const w = window as any
        let evalSource: any = sourceCode
        if (w.trustedTypes) {
          if (!w[TT]) {
            w[TT] = w.trustedTypes.createPolicy(ttName, {
              createScript: (s: string) => s
            })
          }
          evalSource = w[TT].createScript(sourceCode)
        }
        const value = (0, eval)(evalSource as string)
        return { success: true, data: await normalize(value) }
      } catch (err) {
        return { success: false, error: (err as Error).message || String(err) }
      }
    }
  })

  return (results[0]?.result as ActionResult) ?? { success: false, error: "no result" }
}

async function prepareByteSource(
  tabId: number,
  code: string,
  world: "MAIN" | "ISOLATED"
): Promise<ActionResult> {
  // Reuse the shared CSP / Trusted-Types bypass (runWithCspStripBypass) so the
  // binary sink can extract bytes from strict-CSP pages — including
  // require-trusted-types-for 'script' sites like NotebookLM — exactly like
  // `interceptor eval` does, instead of the weaker bespoke eval this used to
  // carry. On the bypass path the page is reloaded, so the expression must be
  // self-contained: it is re-run against the freshly reloaded page.
  const evalResult = await runWithCspStripBypass(
    tabId,
    world,
    (t, w) => executeNormalize(t, w, code)
  )
  if (!evalResult.success) return evalResult

  // The TT / CSP fallback paths wrap the value as
  // { value, cspBypassApplied, originalError }; unwrap it
  // back to the bare ByteSource descriptor.
  let descriptor: any = evalResult.data
  if (
    descriptor && typeof descriptor === "object" &&
    !("url" in descriptor) && "value" in descriptor
  ) {
    descriptor = descriptor.value
  }
  if (!descriptor || typeof descriptor !== "object" || typeof descriptor.url !== "string") {
    return { success: false, error: "byte source normalization returned no blob URL" }
  }
  return { success: true, data: descriptor as ByteSource }
}

async function cleanupByteSource(tabId: number, source: ByteSource, world: "MAIN" | "ISOLATED"): Promise<void> {
  if (!source.created) return
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world,
      args: [source.url],
      func: (url: string) => {
        try { URL.revokeObjectURL(url) } catch {}
      }
    })
  } catch {}
}

type StagedByteSource = {
  key: string
  bytes: number
}

type SinkSocket = {
  ws: WebSocket
  sinkId: string
  request: (payload: Record<string, unknown>) => Promise<any>
  sendChunk: (seq: number, bytes: Uint8Array) => Promise<void>
  close: () => void
}

async function stageByteSource(tabId: number, source: ByteSource): Promise<StagedByteSource> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    args: [source.url],
    func: async (url: string) => {
      const response = await fetch(url)
      if (!response.ok && !url.startsWith("blob:")) {
        throw new Error(`source fetch failed: ${response.status} ${response.statusText}`)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      // Staged in the ISOLATED content-script world (see world: "ISOLATED" above),
      // not the page's MAIN world — so this key is not enumerable by the page and
      // is intentionally left as a plain string rather than de-branded (#178).
      const key = "__interceptor_binary_sink_" + crypto.randomUUID().replace(/-/g, "")
      ;(globalThis as any)[key] = bytes
      return { key, bytes: bytes.byteLength }
    }
  })

  const result = results[0]?.result as StagedByteSource | undefined
  if (!result?.key || typeof result.bytes !== "number") {
    throw new Error("failed to stage byte source")
  }
  return result
}

async function cleanupStagedByteSource(tabId: number, staged: StagedByteSource | null): Promise<void> {
  if (!staged) return
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      args: [staged.key],
      func: (key: string) => {
        try { delete (globalThis as any)[key] } catch {}
      }
    })
  } catch {}
}

async function readStagedChunk(tabId: number, key: string, offset: number, length: number): Promise<Uint8Array> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    args: [key, offset, length],
    func: (sourceKey: string, start: number, count: number) => {
      const bytes = (globalThis as any)[sourceKey] as Uint8Array | undefined
      if (!bytes) throw new Error("staged bytes not found")
      const end = Math.min(start + count, bytes.byteLength)
      const slice = bytes.subarray(start, end)
      let binary = ""
      const block = 0x8000
      for (let i = 0; i < slice.byteLength; i += block) {
        binary += String.fromCharCode(...slice.subarray(i, Math.min(i + block, slice.byteLength)))
      }
      return btoa(binary)
    }
  })

  const b64 = results[0]?.result as string | undefined
  if (typeof b64 !== "string") throw new Error("failed to read staged chunk")
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function connectSinkSocket(): Promise<SinkSocket> {
  const WS_URL = "ws://localhost:19222"
  const MAGIC = new Uint8Array([0x49, 0x42, 0x53, 0x31]) // IBS1
  const encoder = new TextEncoder()
  const sinkId = crypto.randomUUID()
  const pending = new Map<string, { resolve: (value: any) => void; reject: (err: Error) => void }>()

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.binaryType = "arraybuffer"
    const timer = setTimeout(() => reject(new Error("binary sink websocket open timeout")), 10_000)

    ws.onopen = () => {
      clearTimeout(timer)
      const request = (payload: Record<string, unknown>): Promise<any> => {
        const id = crypto.randomUUID()
        payload.id = id
        return new Promise((reqResolve, reqReject) => {
          pending.set(id, { resolve: reqResolve, reject: reqReject })
          ws.send(JSON.stringify(payload))
        })
      }

      const waitForBackpressure = async (): Promise<void> => {
        while (ws.bufferedAmount > 16 * 1024 * 1024) await wait(5)
      }

      const sendChunk = async (seq: number, bytes: Uint8Array): Promise<void> => {
        const header = encoder.encode(JSON.stringify({ sinkId, seq }))
        const frame = new Uint8Array(8 + header.byteLength + bytes.byteLength)
        frame.set(MAGIC, 0)
        new DataView(frame.buffer).setUint32(4, header.byteLength, true)
        frame.set(header, 8)
        frame.set(bytes, 8 + header.byteLength)
        ws.send(frame)
        await waitForBackpressure()
      }

      resolve({
        ws,
        sinkId,
        request,
        sendChunk,
        close: () => ws.close()
      })
    }

    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error("binary sink websocket failed"))
    }

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return
      let message: any
      try { message = JSON.parse(event.data) } catch { return }
      if (!message.id || !pending.has(message.id)) return
      const callbacks = pending.get(message.id)!
      pending.delete(message.id)
      callbacks.resolve(message)
    }

    ws.onclose = () => {
      for (const callbacks of pending.values()) {
        callbacks.reject(new Error("binary sink websocket closed"))
      }
      pending.clear()
    }
  })
}

async function streamByteSource(tabId: number, source: ByteSource, out: string, chunkSize: number): Promise<ActionResult> {
  let staged: StagedByteSource | null = null
  let socket: SinkSocket | null = null
  let seq = 0
  let streamed = 0

  try {
    staged = await stageByteSource(tabId, source)
    socket = await connectSinkSocket()

    const open = await socket.request({
      type: "binary_sink_open",
      sinkId: socket.sinkId,
      path: out,
      expectedBytes: staged.bytes,
      mime: source.mime,
      sourceUrl: source.url
    })
    if (!open.result?.success) throw new Error(open.result?.error || "binary sink open failed")

    for (let offset = 0; offset < staged.bytes; offset += chunkSize) {
      const bytes = await readStagedChunk(tabId, staged.key, offset, chunkSize)
      if (bytes.byteLength === 0) continue
      await socket.sendChunk(seq++, bytes)
      streamed += bytes.byteLength
    }

    while (socket.ws.bufferedAmount > 0) await wait(5)
    const close = await socket.request({ type: "binary_sink_close", sinkId: socket.sinkId })
    if (!close.result?.success) throw new Error(close.result?.error || "binary sink close failed")
    return {
      success: true,
      data: {
        ...(close.result.data || {}),
        sourceKind: source.kind,
        sourceMime: source.mime,
        sourceBytes: source.size,
        stagedBytes: staged.bytes,
        streamedBytes: streamed,
        chunks: seq
      }
    }
  } catch (err) {
    if (socket) {
      try {
        await socket.request({ type: "binary_sink_abort", sinkId: socket.sinkId, reason: (err as Error).message || String(err) })
      } catch {}
    }
    return { success: false, error: (err as Error).message || String(err) }
  } finally {
    if (socket) socket.close()
    await cleanupStagedByteSource(tabId, staged)
  }
}

export async function handleBinarySinkActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  if (action.type !== "binary_sink_save") {
    return { success: false, error: `unknown binary-sink action: ${action.type}` }
  }

  const code = action.code as string
  const out = action.out as string
  const world = (action.world as string) === "ISOLATED" ? "ISOLATED" : "MAIN"
  const chunkSize = typeof action.chunkSize === "number" && action.chunkSize > 0
    ? Math.floor(action.chunkSize)
    : DEFAULT_CHUNK_SIZE

  if (!out) return { success: false, error: "missing output path" }
  if (!code) return { success: false, error: "missing expression" }

  const prepared = await prepareByteSource(tabId, code, world)
  if (!prepared.success) return prepared

  const source = prepared.data as ByteSource
  try {
    return await streamByteSource(tabId, source, out, chunkSize)
  } finally {
    await cleanupByteSource(tabId, source, world)
  }
}
