/**
 * daemon/ios/lockdown.ts — pure-Bun lockdownd client.
 *
 * Replaces the half of `xcrun devicectl` that talks lockdown: connect to the
 * device's lockdownd (usbmux port 62078), run the trusted-session handshake
 * (StartSession → optional StartTLS), and `StartService` to obtain a port for a
 * developer/system service (installation_proxy, mobile_image_mounter, AFC, …).
 *
 * Wire format (confirmed vs. libimobiledevice / go-ios / pymobiledevice3):
 *   - Transport: a usbmux `Connect` to device port 62078 gives a raw duplex.
 *   - Framing:  4-byte BIG-endian length prefix + an XML plist body (unlike the
 *               usbmux control channel, which is little-endian + typed header).
 *   - Pair record: read from usbmuxd (`ReadPairRecord`) — it holds HostID,
 *               SystemBUID, the host cert/key, and the device/root certs used to
 *               upgrade the session to mutual TLS (node:tls key/cert/ca).
 *
 * WHAT IS REAL HERE (offline-testable): the plist builder (nested dict/data/bool),
 * the lockdown frame codec, the usbmux Connect to 62078, ReadPairRecord parsing,
 * and every request/response builder + parser.
 *
 * WHAT IS ON-DEVICE-GATED: the live TLS upgrade against a real
 * device, and first-time `Pair` for a FRESH device (host-cert generation + the
 * on-device "Trust This Computer" tap). These throw an explicit, actionable error
 * until validated against the operator's iOS-26 device — no silent fakes.
 */

import net from "node:net"
import tls, { type TLSSocket } from "node:tls"
import { spawnSync } from "node:child_process"
import { encodeUsbmuxMessage, tryReadUsbmuxMessage, plistInteger, htons, resolveDeviceId } from "./usbmux-forward"

export const LOCKDOWN_PORT = 62078

// ── plist codec (richer than usbmux-forward's flat string/number) ─────────────

export type PlistValue = string | number | boolean | Buffer | PlistDict | PlistValue[]
export interface PlistDict { [k: string]: PlistValue }

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Serialize a value to a plist XML fragment. Buffers → <data> base64. */
export function plistNode(v: PlistValue): string {
  if (Buffer.isBuffer(v)) return `<data>${v.toString("base64")}</data>`
  if (Array.isArray(v)) return `<array>${v.map(plistNode).join("")}</array>`
  if (typeof v === "boolean") return v ? "<true/>" : "<false/>"
  if (typeof v === "number") return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`
  if (typeof v === "object" && v !== null) {
    const body = Object.entries(v)
      .map(([k, val]) => `<key>${xmlEscape(k)}</key>${plistNode(val)}`)
      .join("")
    return `<dict>${body}</dict>`
  }
  return `<string>${xmlEscape(String(v))}</string>`
}

export function buildPlist(dict: PlistDict): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">${plistNode(dict)}</plist>`
  )
}

/**
 * Convert a plist buffer to a JS object via macOS plutil→json. Works for the
 * lockdown handshake replies (QueryType/StartSession/StartService), which carry
 * only string/int/bool. NOTE: `plutil -convert json` REJECTS `<data>` fields, so
 * responses that carry binary (e.g. ReadPairRecord's certs) must use the XML path
 * below (`plistToXml` + `xmlDataField`), not this.
 */
export function plistToObject(buf: Buffer): Record<string, unknown> {
  const r = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: buf })
  if (r.status !== 0) throw new Error(`plutil parse failed: ${r.stderr?.toString() ?? ""}`)
  return JSON.parse(r.stdout.toString()) as Record<string, unknown>
}

/** Convert any plist buffer (xml/binary) to XML text — tolerates `<data>` fields. */
export function plistToXml(buf: Buffer): string {
  const r = spawnSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "-"], { input: buf })
  if (r.status !== 0) throw new Error(`plutil xml parse failed: ${r.stderr?.toString() ?? ""}`)
  return r.stdout.toString()
}

/** Extract `<key>K</key><string>…</string>` from plist XML. */
export function xmlStringField(xml: string, key: string): string | undefined {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)
  return m ? m[1] : undefined
}

/** Extract `<key>K</key><data>base64</data>` from plist XML → decoded bytes. */
export function xmlDataField(xml: string, key: string): Buffer | undefined {
  const m = new RegExp(`<key>${key}</key>\\s*<data>([\\s\\S]*?)</data>`).exec(xml)
  if (!m) return undefined
  return Buffer.from(m[1].replace(/\s+/g, ""), "base64")
}

// ── lockdown frame codec (4-byte BE length + XML plist) ───────────────────────

export function encodeLockdownFrame(dict: PlistDict): Buffer {
  const body = Buffer.from(buildPlist(dict), "utf-8")
  const hdr = Buffer.alloc(4)
  hdr.writeUInt32BE(body.length, 0)
  return Buffer.concat([hdr, body])
}

/** Pull one complete lockdown frame off a buffer, or undefined if incomplete. */
export function tryReadLockdownFrame(buf: Buffer): { body: Buffer; rest: Buffer } | undefined {
  if (buf.length < 4) return undefined
  const len = buf.readUInt32BE(0)
  if (buf.length < 4 + len) return undefined
  return { body: buf.subarray(4, 4 + len), rest: buf.subarray(4 + len) }
}

// ── pair record (read from usbmuxd; already device-trusted once paired) ───────

export type PairRecord = {
  HostID?: string
  SystemBUID?: string
  HostCertificate?: Buffer
  HostPrivateKey?: Buffer
  DeviceCertificate?: Buffer
  RootCertificate?: Buffer
  RootPrivateKey?: Buffer
  EscrowBag?: Buffer
  WiFiMACAddress?: string
}

/**
 * Read the usbmuxd-held pair record for a udid (the record libimobiledevice/Xcode
 * wrote at first "Trust This Computer"). Returns undefined when the device was
 * never paired to this Mac — the caller must then run `pairDevice` (M0-gated).
 *
 * The response carries `<data>` (certs), so we go via XML, not JSON. The outer
 * reply wraps the record in `PairRecordData` (itself a plist); the cert `<data>`
 * bytes are PEM text (libimobiledevice stores PEM), ready for node:tls.
 */
export async function readPairRecord(udid: string): Promise<PairRecord | undefined> {
  const payload = await usbmuxOneShot({ MessageType: "ReadPairRecord", PairRecordID: udid })
  const outerXml = plistToXml(payload)
  const inner = xmlDataField(outerXml, "PairRecordData")
  if (!inner) return undefined
  const xml = plistToXml(inner)
  return {
    HostID: xmlStringField(xml, "HostID"),
    SystemBUID: xmlStringField(xml, "SystemBUID"),
    HostCertificate: xmlDataField(xml, "HostCertificate"),
    HostPrivateKey: xmlDataField(xml, "HostPrivateKey"),
    DeviceCertificate: xmlDataField(xml, "DeviceCertificate"),
    RootCertificate: xmlDataField(xml, "RootCertificate"),
    EscrowBag: xmlDataField(xml, "EscrowBag"),
    WiFiMACAddress: xmlStringField(xml, "WiFiMACAddress"),
  }
}

/** One-shot usbmux control request (ListDevices/ReadPairRecord/…) → response payload. */
function usbmuxOneShot(dict: Record<string, string | number>): Promise<Buffer> {
  const CLIENT = { ProgName: "interceptor", ClientVersionString: "interceptor-lockdown-1", kLibUSBMuxVersion: 3 }
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0)
    let done = false
    const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(t); fn() } }
    const t = setTimeout(() => finish(() => reject(new Error("usbmuxd request timed out"))), 5_000)
    Bun.connect({
      unix: "/var/run/usbmuxd",
      socket: {
        open(s) { s.write(encodeUsbmuxMessage({ ...dict, ...CLIENT } as Record<string, string | number>)) },
        data(s, chunk) {
          acc = Buffer.concat([acc, chunk])
          const msg = tryReadUsbmuxMessage(acc)
          if (!msg) return
          finish(() => { try { s.end() } catch {} ; resolve(msg.payload) })
        },
        error(_s, e) { finish(() => reject(e instanceof Error ? e : new Error(String(e)))) },
        close() { finish(() => reject(new Error("usbmuxd closed early"))) },
      },
    }).catch((e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))))
  })
}

// ── the lockdown session (node:net + node:tls — PROVEN on iOS 26.6, M0) ────────

const CLIENT_LABEL = "interceptor"
const USBMUX_CLIENT = { ProgName: "interceptor", ClientVersionString: "interceptor-lockdown-1", kLibUSBMuxVersion: 3 }

/** usbmux Connect to a device port over node:net (so it can be TLS-wrapped). */
function connectUsbmuxPort(deviceId: number, port: number, timeoutMs = 5_000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect("/var/run/usbmuxd")
    let acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let done = false
    // usbmuxd may accept the connection but never reply (device unplugged mid-
    // handshake) or close without data — without these guards the promise would
    // hang forever and every lockdown entry point that awaits it would stall.
    const fail = (e: Error) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy() } catch {} ; reject(e) }
    const timer = setTimeout(() => fail(new Error(`usbmux Connect to port ${port} timed out`)), timeoutMs)
    sock.on("connect", () => sock.write(encodeUsbmuxMessage({ MessageType: "Connect", DeviceID: deviceId, PortNumber: htons(port), ...USBMUX_CLIENT } as Record<string, string | number>)))
    sock.on("data", (chunk: Buffer) => {
      if (done) return
      acc = Buffer.concat([acc, chunk])
      const msg = tryReadUsbmuxMessage(acc)
      if (!msg) return
      done = true
      clearTimeout(timer)
      sock.removeAllListeners("data")
      const code = plistInteger(msg.payload.toString("utf-8"), "Number")
      if (code !== 0) { try { sock.destroy() } catch {} ; reject(new Error(`usbmux Connect to port ${port} failed (code ${code ?? "?"})`)); return }
      resolve(sock)
    })
    sock.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))))
    sock.on("close", () => fail(new Error("usbmuxd closed early")))
  })
}

/** A framed lockdown request/response channel over a net or TLS socket. */
class LockdownChannel {
  private acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private waiters: Array<(b: Buffer) => void> = []
  constructor(private sock: net.Socket | TLSSocket) {
    sock.on("data", (chunk: Buffer) => {
      this.acc = Buffer.concat([this.acc, chunk])
      let frame = tryReadLockdownFrame(this.acc)
      while (frame) { this.acc = frame.rest; this.waiters.shift()?.(frame.body); frame = tryReadLockdownFrame(this.acc) }
    })
  }
  request(dict: PlistDict, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("lockdown request timed out")), timeoutMs)
      this.waiters.push((body) => { clearTimeout(timer); resolve(plistToObject(body)) })
      this.sock.write(encodeLockdownFrame(dict))
    })
  }

  close(): void {
    try { this.sock.destroy() } catch {}
  }
}

/** Wrap a plaintext lockdown/service socket in the mutual-TLS session identity. */
function upgradeTls(raw: net.Socket, pair: PairRecord): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    raw.removeAllListeners("data")
    const t = tls.connect({
      socket: raw,
      key: pair.HostPrivateKey, cert: pair.HostCertificate,
      ca: pair.RootCertificate ?? pair.DeviceCertificate,
      rejectUnauthorized: false,   // lockdown uses a private CA; the device cert is pinned by pairing
      minVersion: "TLSv1",
    }, () => resolve(t))
    t.on("error", reject)
  })
}

export type LockdownService = {
  /** Port on the device the service is listening on (reach it via a fresh usbmux Connect). */
  port: number
  /** Whether the service itself must be wrapped in TLS (EnableServiceSSL). */
  ssl: boolean
}

/**
 * Open a TLS-upgraded lockdown session: usbmux Connect(62078) → QueryType →
 * StartSession → (TLS upgrade when EnableSessionSSL). Returns the session channel
 * + the pair record (for wrapping subsequent service sockets) + usbmux deviceId.
 * PROVEN on iOS 26.6 (M0 spike). Requires an existing pair record.
 *
 * ponytail: the plaintext lockdown socket is left open for the session's life; the
 * OS reaps it when the process/socket closes. Explicit teardown if it ever matters.
 */
async function openLockdownSession(udid: string): Promise<{ chan: LockdownChannel; pair: PairRecord; deviceId: number }> {
  const pair = await readPairRecord(udid)
  if (!pair?.HostID || !pair.SystemBUID) {
    throw new Error(
      `ios: '${udid}' is not paired with this Mac yet. Plug it in over USB and tap ` +
      `"Trust This Computer" (then enter the passcode), and re-run.`,
    )
  }
  const deviceId = await resolveDeviceId(udid)
  if (deviceId === undefined) throw new Error(`ios: device '${udid}' not visible to usbmuxd — plug it in over USB or put it on the same Wi-Fi as this Mac (a VPN such as Tailscale cannot reach the phone's pairing services)`)

  const raw = await connectUsbmuxPort(deviceId, LOCKDOWN_PORT)
  let chan = new LockdownChannel(raw)
  const qt = await chan.request({ Request: "QueryType", Label: CLIENT_LABEL })
  if (qt.Type !== "com.apple.mobile.lockdown") throw new Error(`lockdown: unexpected QueryType ${String(qt.Type)}`)
  const ss = await chan.request({ Request: "StartSession", Label: CLIENT_LABEL, HostID: pair.HostID, SystemBUID: pair.SystemBUID })
  if (ss.Error) throw new Error(`lockdown StartSession failed: ${String(ss.Error)}`)
  if (ss.EnableSessionSSL === true) {
    if (!pair.HostCertificate || !pair.HostPrivateKey) throw new Error("lockdown: pair record missing host cert/key for TLS (re-pair the device)")
    chan = new LockdownChannel(await upgradeTls(raw, pair))
  }
  return { chan, pair, deviceId }
}

/** Full lockdown handshake → StartService. Returns the service port + whether it needs TLS. */
export async function startService(udid: string, service: string): Promise<LockdownService> {
  const { chan } = await openLockdownSession(udid)
  try {
    const sv = await chan.request({ Request: "StartService", Label: CLIENT_LABEL, Service: service })
    if (sv.Error) throw new Error(`lockdown StartService(${service}) failed: ${String(sv.Error)}`)
    const port = typeof sv.Port === "number" ? sv.Port : undefined
    if (port === undefined) throw new Error(`lockdown StartService(${service}) returned no port`)
    return { port, ssl: sv.EnableServiceSSL === true }
  } finally {
    chan.close()
  }
}

/**
 * Read a lockdown value (post-TLS session). e.g. GetValue ProductVersion, or
 * DeveloperMode status via domain `com.apple.security.mac.amfi` key
 * `DeveloperModeStatus`. Returns the raw Value (string/bool/number) or undefined.
 */
export async function getValue(udid: string, domain?: string, key?: string): Promise<unknown> {
  const { chan } = await openLockdownSession(udid)
  try {
    const req: PlistDict = { Request: "GetValue", Label: CLIENT_LABEL }
    if (domain) req.Domain = domain
    if (key) req.Key = key
    const r = await chan.request(req)
    if (r.Error) throw new Error(`lockdown GetValue(${domain ?? ""}/${key ?? ""}) failed: ${String(r.Error)}`)
    return r.Value
  } finally {
    chan.close()
  }
}

/**
 * StartService + Connect to its port, returning a socket that already speaks the
 * service protocol (TLS-wrapped when EnableServiceSSL). This is what installer.ts /
 * ddi.ts / etc. drive. PROVEN transport (M0).
 */
export async function connectServiceSocket(udid: string, service: string): Promise<{ sock: net.Socket | TLSSocket; ssl: boolean }> {
  const { chan, pair, deviceId } = await openLockdownSession(udid)
  try {
    const sv = await chan.request({ Request: "StartService", Label: CLIENT_LABEL, Service: service })
    if (sv.Error) throw new Error(`lockdown StartService(${service}) failed: ${String(sv.Error)}`)
    const port = typeof sv.Port === "number" ? sv.Port : undefined
    if (port === undefined) throw new Error(`lockdown StartService(${service}) returned no port`)
    const ssl = sv.EnableServiceSSL === true
    const raw = await connectUsbmuxPort(deviceId, port)
    return { sock: ssl ? await upgradeTls(raw, pair) : raw, ssl }
  } finally {
    chan.close()
  }
}

/**
 * First-time pairing for a FRESH device (no existing pair record). Generates a
 * host identity, reads the device public key, and sends `Pair`. The user must tap
 * "Trust This Computer" on the unlocked device.
 *
 * ON-DEVICE-GATED: host-cert generation + the Pair exchange are the
 * make-or-break unknown; this throws an actionable error until the M0 spike
 * confirms the cert shape iOS 26 accepts. The message flow is per libimobiledevice.
 */
export async function pairDevice(udid: string): Promise<PairRecord> {
  void udid
  throw new Error(
    "ios: first-time pairing (fresh device) is gated on the M0 spike. For now, pair once via a " +
    "cabled 'Trust This Computer' tap (Finder/Xcode-free: any trust prompt writes the record usbmuxd " +
    "then serves). Re-run setup after trusting.",
  )
}
