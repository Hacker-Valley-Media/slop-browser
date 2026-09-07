/**
 * Runner dial-back host selection.
 *
 * The on-device XCUITest runner dials back into the daemon's WebSocket. XCTest
 * backgrounds the runner before it dials, and iOS silently denies a backgrounded
 * app's first local-network connection while its Local Network privilege is
 * undetermined (Apple TN3179). A VPN address is not "local" under that policy,
 * so it is the one address proven to connect (live A/B 2026-09-06: the LAN
 * address never connected, the Tailscale address connected in 2 s).
 *
 * Ladder: INTERCEPTOR_WS_URL override → simulator loopback → CGNAT/VPN (utun)
 * → the Mac interface usbmuxd discovered the phone on (its InterfaceIndex equals
 * that interface's IPv6 scopeid; usbmuxd reports the phone's GLOBAL IPv6 on this
 * Mac, so an IPv4 subnet match alone never fires) → the Mac interface on the
 * phone's own IPv4 subnet → default-route interface → first non-internal IPv4 →
 * loopback.
 */
import { networkInterfaces } from "node:os"
import { execFileSync } from "node:child_process"
import type { IosDeviceKind, IosDialBackVia } from "../../shared/ios-device"
import { usbmuxListDevices } from "./usbmux-forward"

/** `index` is the kernel interface index (usbmuxd's InterfaceIndex), when the table exposes it. */
export type Iface = { name: string; address: string; netmask: string; index?: number }
export type DialBack = { url: string; host: string; via: IosDialBackVia }
/** What usbmuxd knows about the phone's network attachment. */
export type PhoneLink = { address?: string; interfaceIndex?: number }

/** Non-internal IPv4 interfaces in enumeration order; link-local excluded. */
export function ifaceTable(table: ReturnType<typeof networkInterfaces> = networkInterfaces()): Iface[] {
  const out: Iface[] = []
  for (const [name, addrs] of Object.entries(table)) {
    // Node/Bun expose the interface index only as the scopeid of link-local IPv6 entries.
    const index = (addrs ?? []).find((ni) => ni.family === "IPv6" && ni.scopeid > 0)?.scopeid
    for (const ni of addrs ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue
      if (ni.address.startsWith("169.254.")) continue
      out.push(index ? { name, address: ni.address, netmask: ni.netmask, index } : { name, address: ni.address, netmask: ni.netmask })
    }
  }
  return out
}

function ip4(s: string): number | undefined {
  const parts = s.split(".")
  if (parts.length !== 4) return undefined
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined
    const v = Number(p)
    if (v > 255) return undefined
    n = n * 256 + v
  }
  return n
}

/** 100.64.0.0/10 — the CGNAT range Tailscale (and similar VPNs) hand out. */
export function isCgnat(address: string): boolean {
  const n = ip4(address)
  return n !== undefined && n >= 0x64400000 && n <= 0x647fffff
}

/** VPN = a CGNAT address on a tunnel interface (utun on macOS, tailscale/wg elsewhere). */
export function isVpnIface(iface: Iface): boolean {
  return /^(utun|tailscale|wg)/.test(iface.name) && isCgnat(iface.address)
}

/** True when `address` is inside the interface's IPv4 subnet (a /32 never contains another host). */
export function sameSubnet(address: string, iface: Iface): boolean {
  const a = ip4(address), b = ip4(iface.address), m = ip4(iface.netmask)
  if (a === undefined || b === undefined || m === undefined) return false
  if (m === 0xffffffff) return false
  return ((a & m) >>> 0) === ((b & m) >>> 0)
}

/** Pure ladder over an interface table. `undefined` only when the table is empty. */
export function pickRunnerWsHost(input: {
  ifaces: Iface[]
  phoneAddress?: string
  phoneInterfaceIndex?: number
  defaultRouteIface?: string
}): { host: string; via: IosDialBackVia } | undefined {
  const { ifaces, phoneAddress, phoneInterfaceIndex, defaultRouteIface } = input
  const vpn = ifaces.find(isVpnIface)
  if (vpn) return { host: vpn.address, via: "vpn" }
  if (phoneInterfaceIndex) {
    const i = ifaces.find((x) => x.index === phoneInterfaceIndex)
    if (i) return { host: i.address, via: "interface" }
  }
  if (phoneAddress) {
    const s = ifaces.find((i) => sameSubnet(phoneAddress, i))
    if (s) return { host: s.address, via: "subnet" }
  }
  if (defaultRouteIface) {
    const d = ifaces.find((i) => i.name === defaultRouteIface)
    if (d) return { host: d.address, via: "default-route" }
  }
  if (ifaces[0]) return { host: ifaces[0].address, via: "first" }
  return undefined
}

export function classifyDialBackHost(host: string): "loopback" | "vpn" | "lan" {
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return "loopback"
  if (isCgnat(host)) return "vpn"
  return "lan"
}

/** What to do when the runner never registers, phrased per the address class it was handed. */
export function runnerDialHint(d: DialBack): string {
  if (d.via === "override") return `INTERCEPTOR_WS_URL is set; confirm the phone can reach ${d.url} and is unlocked.`
  if (d.via === "loopback") return "confirm the simulator booted."
  if (classifyDialBackHost(d.host) === "vpn") return "confirm the phone is on the same VPN as this Mac (Tailscale) and is unlocked."
  return `${d.host} is a local-network address. iOS silently denies a backgrounded app's first local-network connection (Local Network privacy), and XCTest backgrounds the runner before it dials. Grant InterceptorRunner Local Network access (Settings › Privacy & Security › Local Network) and local-network dial-back works, put the phone and this Mac on the same VPN (Tailscale) so the daemon hands out a non-local address, or set INTERCEPTOR_WS_URL.`
}

/** `route -n get default` → interface name (macOS). Undefined anywhere else or on failure. */
export function defaultRouteInterface(): string | undefined {
  if (process.platform !== "darwin") return undefined
  try {
    return execFileSync("/sbin/route", ["-n", "get", "default"], { timeout: 2000 }).toString().match(/interface:\s*(\w+)/)?.[1]
  } catch { return undefined }
}

/** The phone's network attachment as usbmuxd sees it (Wi-Fi devices only). */
export async function usbmuxPhoneLink(udid: string): Promise<PhoneLink | undefined> {
  const wanted = udid.trim().toLowerCase()
  const devices = await usbmuxListDevices()
  const d = devices.find((x) => x.udid.trim().toLowerCase() === wanted && (x.networkAddress || x.interfaceIndex))
  return d ? { address: d.networkAddress, interfaceIndex: d.interfaceIndex } : undefined
}

export type DialBackIo = {
  ifaces: () => Iface[]
  phone: (udid: string) => Promise<PhoneLink | undefined>
  defaultRouteIface: () => string | undefined
  env: NodeJS.ProcessEnv
}

export const defaultDialBackIo: DialBackIo = {
  ifaces: () => ifaceTable(),
  phone: usbmuxPhoneLink,
  defaultRouteIface: defaultRouteInterface,
  env: process.env,
}

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

/** Resolve the dial-back the runner is handed. Never throws; every I/O failure degrades to the next rung. */
export async function resolveRunnerDialBack(
  kind: IosDeviceKind, udid: string, wsPort: number, io: DialBackIo = defaultDialBackIo,
): Promise<DialBack> {
  const override = io.env.INTERCEPTOR_WS_URL
  if (override) return { url: override, host: hostOf(override), via: "override" }
  const loopback: DialBack = { url: `ws://127.0.0.1:${wsPort}`, host: "127.0.0.1", via: "loopback" }
  if (kind === "simulator") return loopback
  let phone: PhoneLink | undefined
  try { phone = await io.phone(udid) } catch { phone = undefined }
  let ifaces: Iface[] = []
  try { ifaces = io.ifaces() } catch { ifaces = [] }
  let defaultRouteIface: string | undefined
  try { defaultRouteIface = io.defaultRouteIface() } catch { defaultRouteIface = undefined }
  const pick = pickRunnerWsHost({ ifaces, phoneAddress: phone?.address, phoneInterfaceIndex: phone?.interfaceIndex, defaultRouteIface })
  if (!pick) return loopback
  return { url: `ws://${pick.host}:${wsPort}`, host: pick.host, via: pick.via }
}
