/**
 * daemon/ios/usbmux-forward.ts — native, dependency-free usbmux port-forwarder.
 *
 * Replaces `go-ios forward` / `pymobiledevice3` for reaching WebDriverAgent's
 * HTTP port on a physical device. It talks to macOS's OWN usbmux daemon at
 * `/var/run/usbmuxd` (the same daemon Xcode uses), so there is nothing to
 * install: pure Bun sockets + a hand-rolled plist, ~zero crypto.
 *
 * Why this is sufficient (verified against go-ios + pymobiledevice3 sources):
 *   - Forwarding an app TCP port is a plain usbmux `Connect` — it does NOT use
 *     the iOS 17+ RemoteXPC tunnel (go-ios `forward` never checks SupportsRsd();
 *     the tunnel is only for developer shim services like testmanagerd, which
 *     Xcode owns when it launches WDA via `xcodebuild test-without-building`).
 *   - A bare `Connect` to an app port needs no pair record and no SSL (those are
 *     only for lockdown services). The device is already Xcode-paired/trusted.
 *
 * Wire format (little-endian 16-byte header + XML plist payload), confirmed from
 * go-ios `ios/usbmuxconnection.go` and pymobiledevice3 `usbmux.py`:
 *   Length  u32 = 16 + payloadLen
 *   Version u32 = 1  (PLIST)
 *   Request u32 = 8  (PLIST message)
 *   Tag     u32
 *   payload = XML plist dict
 * `Connect` carries DeviceID (the integer usbmux id, NOT the udid) and
 * PortNumber in network byte order (htons). Success = response `Number == 0`.
 */

import { socketWriteAll, drainSocketQueue, releaseSocketQueue } from "../socket-write"

const USBMUXD_SOCKET = "/var/run/usbmuxd"

const USBMUX_HEADER_LEN = 16
const USBMUX_VERSION_PLIST = 1
const USBMUX_REQUEST_PLIST = 8

let nextTag = 1

// ── plist + header codec (no library) ────────────────────────────────────────

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Build a flat XML plist dict from string/number values. */
export function buildPlistXml(dict: Record<string, string | number>): string {
  const body = Object.entries(dict)
    .map(([k, v]) =>
      `<key>${xmlEscape(k)}</key>` +
      (typeof v === "number" ? `<integer>${v}</integer>` : `<string>${xmlEscape(v)}</string>`),
    )
    .join("")
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>${body}</dict></plist>`
  )
}

/** Network byte order for a 16-bit port (htons). */
export function htons(port: number): number {
  return ((port & 0xff) << 8) | ((port >> 8) & 0xff)
}

/** Encode a usbmux PLIST message: 16-byte LE header + XML plist payload. */
export function encodeUsbmuxMessage(dict: Record<string, string | number>, tag = nextTag++): Buffer {
  const payload = Buffer.from(buildPlistXml(dict), "utf-8")
  const header = Buffer.alloc(USBMUX_HEADER_LEN)
  header.writeUInt32LE(USBMUX_HEADER_LEN + payload.length, 0) // Length (incl header)
  header.writeUInt32LE(USBMUX_VERSION_PLIST, 4)               // Version
  header.writeUInt32LE(USBMUX_REQUEST_PLIST, 8)               // Request (message type)
  header.writeUInt32LE(tag >>> 0, 12)                         // Tag
  return Buffer.concat([header, payload])
}

/**
 * If `buf` holds at least one complete usbmux message, return its payload and
 * the remaining bytes; otherwise undefined (need more data).
 */
export function tryReadUsbmuxMessage(buf: Buffer): { payload: Buffer; rest: Buffer } | undefined {
  if (buf.length < USBMUX_HEADER_LEN) return undefined
  const total = buf.readUInt32LE(0)
  if (total < USBMUX_HEADER_LEN || buf.length < total) return undefined
  return { payload: buf.subarray(USBMUX_HEADER_LEN, total), rest: buf.subarray(total) }
}

/** Pull the integer value of a top-level plist `<key>name</key><integer>N</integer>`. */
export function plistInteger(xml: string, key: string): number | undefined {
  const re = new RegExp(`<key>${key}</key>\\s*<integer>(-?\\d+)</integer>`)
  const m = re.exec(xml)
  return m ? parseInt(m[1], 10) : undefined
}

// ── usbmux requests ──────────────────────────────────────────────────────────

const CLIENT_TAGS = {
  ProgName: "interceptor",
  ClientVersionString: "interceptor-usbmux-1",
  kLibUSBMuxVersion: 3,
} as const

export type MuxDevice = { deviceId: number; udid: string; connectionType: string; networkAddress?: string; interfaceIndex?: number }

/**
 * Decode usbmuxd's `NetworkAddress` <data>: a raw Darwin `struct sockaddr`
 * (libusbmuxd memcpy's it verbatim; libimobiledevice reads `sa_family` from it).
 * Byte 0 sa_len, byte 1 sa_family. AF_INET (2) → address at bytes 4-7;
 * AF_INET6 (30) → address at bytes 8-23. Anything else → undefined.
 */
export function parseUsbmuxNetworkAddress(base64: string): string | undefined {
  const b = Buffer.from(base64.replace(/\s+/g, ""), "base64")
  if (b.length < 8) return undefined
  const family = b[1]
  if (family === 2) return `${b[4]}.${b[5]}.${b[6]}.${b[7]}`
  if (family === 30 && b.length >= 24) {
    const groups: string[] = []
    for (let i = 8; i < 24; i += 2) groups.push(b.readUInt16BE(i).toString(16))
    return groups.join(":")
  }
  return undefined
}

/** Each device entry of a ListDevices reply is a depth-2 <dict> (plist > dict > array > dict). */
function deviceDicts(xml: string): string[] {
  const chunks: string[] = []
  let depth = 0, start = -1
  for (const m of xml.matchAll(/<\/?dict>/g)) {
    if (m[0] === "<dict>") { depth++; if (depth === 2) start = m.index! }
    else { if (depth === 2 && start >= 0) { chunks.push(xml.slice(start, m.index! + "</dict>".length)); start = -1 }; depth-- }
  }
  return chunks
}

/**
 * One-shot usbmux request → first response payload, over a fresh usbmuxd socket.
 * Resolves with the response payload bytes (XML plist).
 */
// One-shot control writes (ListDevices/Connect plists, ~300 bytes on fresh
// sockets) stay bare: they cannot exceed an empty 8 KiB send buffer.
function usbmuxRequest(dict: Record<string, string | number>, timeoutMs = 5_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0)
    let settled = false
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn() } }
    const timer = setTimeout(() => finish(() => reject(new Error("usbmuxd request timed out"))), timeoutMs)
    Bun.connect({
      unix: USBMUXD_SOCKET,
      socket: {
        open(sock) { sock.write(encodeUsbmuxMessage(dict)) },
        data(sock, chunk) {
          acc = Buffer.concat([acc, chunk])
          const msg = tryReadUsbmuxMessage(acc)
          if (!msg) return
          finish(() => { try { sock.end() } catch {} ; resolve(msg.payload) })
        },
        error(_sock, err) { finish(() => reject(err instanceof Error ? err : new Error(String(err)))) },
        close() { finish(() => reject(new Error("usbmuxd closed before responding"))) },
      },
    }).catch((err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))))
  })
}

/**
 * Normalize an XML/binary plist buffer to XML text via macOS `plutil`. We use
 * XML (not JSON) because a usbmuxd ListDevices reply carries `<data>` fields
 * (e.g. EscrowBag) that `plutil -convert json` rejects.
 */
function plistToXml(payload: Buffer): string {
  const proc = Bun.spawnSync(["/usr/bin/plutil", "-convert", "xml1", "-o", "-", "-"], { stdin: payload })
  if (proc.exitCode !== 0) throw new Error(`plutil failed: ${new TextDecoder().decode(proc.stderr)}`)
  return new TextDecoder().decode(proc.stdout)
}

/**
 * Pure parse of a usbmux ListDevices plist (as XML) into {deviceId, udid,
 * connectionType, networkAddress?, interfaceIndex?}. Parsed per device dict, so a reply that
 * carries DeviceID both top-level and inside Properties (libusbmuxd reads it
 * from Properties) still pairs every field with its own device. Robust against
 * the `<data>` fields that break JSON conversion.
 */
export function parseDeviceListXml(xml: string): MuxDevice[] {
  const out: MuxDevice[] = []
  for (const dict of deviceDicts(xml)) {
    const udid = dict.match(/<key>SerialNumber<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
    const id = dict.match(/<key>DeviceID<\/key>\s*<integer>(\d+)<\/integer>/)?.[1]
    if (!udid || !id) continue
    const connectionType = dict.match(/<key>ConnectionType<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "USB"
    const addr = dict.match(/<key>NetworkAddress<\/key>\s*<data>([^<]*)<\/data>/)?.[1]
    const networkAddress = addr ? parseUsbmuxNetworkAddress(addr) : undefined
    // The Mac interface the Wi-Fi device was discovered on (= os.networkInterfaces() scopeid).
    const ifIndex = dict.match(/<key>InterfaceIndex<\/key>\s*<integer>(\d+)<\/integer>/)?.[1]
    const interfaceIndex = ifIndex ? parseInt(ifIndex, 10) : undefined
    out.push({
      deviceId: parseInt(id, 10), udid, connectionType,
      ...(networkAddress ? { networkAddress } : {}),
      ...(interfaceIndex ? { interfaceIndex } : {}),
    })
  }
  return out
}

/**
 * List devices visible to usbmuxd, mapping each udid → its (ephemeral) integer
 * DeviceID, which is what `Connect` requires. devicectl gives udids; this gives
 * the DeviceID. Prefer the USB connection when a device appears twice.
 */
export async function usbmuxListDevices(): Promise<MuxDevice[]> {
  const payload = await usbmuxRequest({ MessageType: "ListDevices", ...CLIENT_TAGS })
  return parseDeviceListXml(plistToXml(payload))
}

export function pickUsbmuxDeviceId(devices: MuxDevice[], udid: string): number | undefined {
  const wanted = udid.trim().toLowerCase()
  const matches = devices.filter((d) => d.udid.trim().toLowerCase() === wanted)
  if (matches.length === 0) return undefined
  const usb = matches.find((d) => /usb/i.test(d.connectionType))
  return (usb ?? matches[0]).deviceId
}

/** Resolve a udid to its usbmux DeviceID (prefers USB over Network). */
export async function resolveDeviceId(udid: string): Promise<number | undefined> {
  return pickUsbmuxDeviceId(await usbmuxListDevices(), udid)
}

// ── the forward ──────────────────────────────────────────────────────────────

export type UsbmuxForward = { hostPort: number; close: () => void }

type DeviceSock = { write: (b: Buffer) => void; end: () => void }
type BridgeState = { device: DeviceSock | null; pending: Buffer[] }

/**
 * Forward `127.0.0.1:hostPort` → device app port `devicePort` over usbmux.
 * Each inbound TCP connection opens its own usbmux `Connect` to the device and
 * pumps bytes both ways until either side closes. Returns a handle whose
 * `close()` stops the listener (in-flight bridges drop with their sockets).
 */
export async function usbmuxForward(udid: string, devicePort: number, hostPort: number): Promise<UsbmuxForward> {
  const deviceId = await resolveDeviceId(udid)
  if (deviceId === undefined) {
    throw new Error(`usbmux: device '${udid}' not visible to usbmuxd — plug it in over USB (trusted) or put it on the same Wi-Fi as this Mac (a VPN such as Tailscale cannot reach the phone's pairing services)`)
  }

  const server = Bun.listen<BridgeState>({
    hostname: "127.0.0.1",
    port: hostPort,
    socket: {
      open(client) {
        const state: BridgeState = { device: null, pending: [] }
        client.data = state
        // Issue #229: pump writes must queue past the kernel send buffer or
        // the dropped tail corrupts the proxied stream.
        openDeviceChannel(deviceId, devicePort, (chunk) => { try { socketWriteAll(client, chunk) } catch {} }, () => { try { client.end() } catch {} })
          .then((deviceSock) => {
            state.device = deviceSock
            for (const c of state.pending) { try { deviceSock.write(c) } catch {} }
            state.pending = []
          })
          .catch(() => { try { client.end() } catch {} })
      },
      data(client, chunk) {
        const s = client.data
        if (s?.device) { try { s.device.write(chunk) } catch {} }
        else s?.pending.push(chunk)
      },
      drain(client) { drainSocketQueue(client) },
      close(client) { releaseSocketQueue(client); closeDevice(client.data) },
      error(client) { releaseSocketQueue(client); closeDevice(client.data) },
    },
  })

  return {
    hostPort,
    close() { try { server.stop(true) } catch {} },
  }
}

function closeDevice(state: BridgeState | undefined): void {
  const dev = state?.device as { end?: () => void } | null
  try { dev?.end?.() } catch {}
}

/**
 * Open a usbmux Connect to (deviceId, devicePort). Resolves with the device
 * socket once the Connect succeeds; after that, device→host bytes are delivered
 * via `onData` and a device-side close triggers `onClose`.
 */
function openDeviceChannel(
  deviceId: number, devicePort: number,
  onData: (chunk: Buffer) => void, onClose: () => void,
): Promise<{ write: (b: Buffer) => void; end: () => void }> {
  return new Promise((resolve, reject) => {
    let bridged = false
    let acc = Buffer.alloc(0)
    let settled = false
    const fail = (err: Error) => { if (!settled) { settled = true; reject(err) } }
    Bun.connect({
      unix: USBMUXD_SOCKET,
      socket: {
        open(sock) {
          sock.write(encodeUsbmuxMessage({ MessageType: "Connect", DeviceID: deviceId, PortNumber: htons(devicePort), ...CLIENT_TAGS }))
        },
        data(sock, chunk) {
          if (bridged) { onData(chunk); return }
          acc = Buffer.concat([acc, chunk])
          const msg = tryReadUsbmuxMessage(acc)
          if (!msg) return
          const num = plistInteger(msg.payload.toString("utf-8"), "Number")
          if (num !== 0) {
            try { sock.end() } catch {}
            fail(new Error(`usbmux Connect to device port ${devicePort} failed (code ${num ?? "?"}) — is WebDriverAgent running on the device?`))
            return
          }
          bridged = true
          settled = true
          // Any bytes already past the result header belong to the bridged stream.
          if (msg.rest.length) onData(msg.rest)
          // Issue #229: the usbmuxd socket has an 8 KiB send buffer; route
          // writes through the backpressure queue so large chunks survive.
          resolve({ write: (b: Buffer) => socketWriteAll(sock, b), end: () => { try { sock.end() } catch {} } })
        },
        drain(sock) { drainSocketQueue(sock) },
        error(sock, err) { releaseSocketQueue(sock); if (bridged) onClose(); else fail(err instanceof Error ? err : new Error(String(err))) },
        close(sock) { releaseSocketQueue(sock); if (bridged) onClose(); else fail(new Error("usbmuxd closed during Connect")) },
      },
    }).catch((err) => fail(err instanceof Error ? err : new Error(String(err))))
  })
}
