import { describe, expect, test } from "bun:test"
import {
  ifaceTable, isCgnat, isVpnIface, sameSubnet, pickRunnerWsHost, classifyDialBackHost,
  runnerDialHint, resolveRunnerDialBack, type Iface, type DialBackIo,
} from "../daemon/ios/ws-host"
import { registrationFailure } from "../daemon/ios/manager"

// This Mac's real table, captured 2026-09-06: Wi-Fi is en1 (the phone's link),
// en0 is wired Ethernet on a different router and holds the default route.
const EN0: Iface = { name: "en0", address: "192.168.0.102", netmask: "255.255.255.0", index: 10 }
const EN1: Iface = { name: "en1", address: "192.168.1.130", netmask: "255.255.255.0", index: 24 }
const BRIDGE: Iface = { name: "bridge0", address: "192.168.2.1", netmask: "255.255.255.0", index: 25 }
const UTUN: Iface = { name: "utun4", address: "100.100.10.20", netmask: "255.255.255.255" }
const REAL = [EN0, EN1, BRIDGE, UTUN]
const PHONE = "192.168.1.57"
// What usbmuxd actually reports for the phone on 2026-09-07: a global IPv6 on interface 24 (en1).
const PHONE_V6 = "2001:db8:1:2:3:4:5:6"
const PHONE_IFINDEX = 24

describe("ifaceTable", () => {
  test("keeps non-internal IPv4 in enumeration order, drops loopback/IPv6/link-local", () => {
    const t = ifaceTable({
      lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true } as any],
      en0: [
        { address: "fe80::1", netmask: "ffff::", family: "IPv6", internal: false, scopeid: 10 } as any,
        { address: "2001:db8::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false, scopeid: 0 } as any,
        { address: "192.168.0.102", netmask: "255.255.255.0", family: "IPv4", internal: false } as any,
      ],
      en5: [{ address: "169.254.10.2", netmask: "255.255.0.0", family: "IPv4", internal: false } as any],
      utun4: [{ address: "100.100.10.20", netmask: "255.255.255.255", family: "IPv4", internal: false } as any],
    })
    expect(t).toEqual([EN0, UTUN])
  })
})

describe("address classification", () => {
  test("isCgnat covers exactly 100.64.0.0/10", () => {
    expect(isCgnat("100.64.0.0")).toBe(true)
    expect(isCgnat("100.100.10.20")).toBe(true)
    expect(isCgnat("100.127.255.255")).toBe(true)
    expect(isCgnat("100.128.0.0")).toBe(false)
    expect(isCgnat("100.63.255.255")).toBe(false)
    expect(isCgnat("192.168.1.130")).toBe(false)
    expect(isCgnat("not-an-ip")).toBe(false)
    expect(isCgnat("100.64.0.999")).toBe(false)
  })
  test("isVpnIface needs a tunnel name AND a CGNAT address", () => {
    expect(isVpnIface(UTUN)).toBe(true)
    expect(isVpnIface({ name: "tailscale0", address: "100.70.1.2", netmask: "255.255.255.255" })).toBe(true)
    expect(isVpnIface({ name: "en0", address: "100.70.1.2", netmask: "255.255.255.0" })).toBe(false)
    expect(isVpnIface({ name: "utun3", address: "10.8.0.2", netmask: "255.255.255.0" })).toBe(false)
  })
  test("sameSubnet matches the phone to en1, not en0; a /32 never contains a host", () => {
    expect(sameSubnet(PHONE, EN1)).toBe(true)
    expect(sameSubnet(PHONE, EN0)).toBe(false)
    expect(sameSubnet(PHONE, BRIDGE)).toBe(false)
    expect(sameSubnet("100.100.10.20", UTUN)).toBe(false)
    expect(sameSubnet("garbage", EN1)).toBe(false)
  })
  test("classifyDialBackHost", () => {
    expect(classifyDialBackHost("127.0.0.1")).toBe("loopback")
    expect(classifyDialBackHost("100.100.10.20")).toBe("vpn")
    expect(classifyDialBackHost("192.168.1.130")).toBe("lan")
  })
})

describe("pickRunnerWsHost ladder (real interface table)", () => {
  test("without a VPN, usbmuxd's InterfaceIndex picks en1 even though the phone address is IPv6 (2026-09-07 live shape)", () => {
    expect(pickRunnerWsHost({ ifaces: [EN0, EN1, BRIDGE], phoneAddress: PHONE_V6, phoneInterfaceIndex: PHONE_IFINDEX, defaultRouteIface: "en0" }))
      .toEqual({ host: "192.168.1.130", via: "interface" })
  })
  test("the interface rung beats the IPv4 subnet rung when both would match", () => {
    expect(pickRunnerWsHost({ ifaces: [EN0, EN1, BRIDGE], phoneAddress: PHONE, phoneInterfaceIndex: PHONE_IFINDEX }))
      .toEqual({ host: "192.168.1.130", via: "interface" })
  })
  test("an index the table does not know falls through to the subnet rung", () => {
    expect(pickRunnerWsHost({ ifaces: [EN0, EN1, BRIDGE], phoneAddress: PHONE, phoneInterfaceIndex: 99, defaultRouteIface: "en0" }))
      .toEqual({ host: "192.168.1.130", via: "subnet" })
  })
  test("VPN still wins when the index is known", () => {
    expect(pickRunnerWsHost({ ifaces: REAL, phoneAddress: PHONE_V6, phoneInterfaceIndex: PHONE_IFINDEX, defaultRouteIface: "en0" }))
      .toEqual({ host: "100.100.10.20", via: "vpn" })
  })
  test("VPN wins when the Mac has a CGNAT utun, even with the phone's subnet known", () => {
    expect(pickRunnerWsHost({ ifaces: REAL, phoneAddress: PHONE, defaultRouteIface: "en0" }))
      .toEqual({ host: "100.100.10.20", via: "vpn" })
  })
  test("without a VPN the phone's own subnet picks en1, not the en0 default route", () => {
    expect(pickRunnerWsHost({ ifaces: [EN0, EN1, BRIDGE], phoneAddress: PHONE, defaultRouteIface: "en0" }))
      .toEqual({ host: "192.168.1.130", via: "subnet" })
  })
  test("no phone address → default-route interface", () => {
    expect(pickRunnerWsHost({ ifaces: [EN0, EN1, BRIDGE], defaultRouteIface: "en0" }))
      .toEqual({ host: "192.168.0.102", via: "default-route" })
  })
  test("phone on an unknown subnet and no default route → first non-internal (today's behavior)", () => {
    expect(pickRunnerWsHost({ ifaces: [EN0, EN1], phoneAddress: "10.0.0.9" }))
      .toEqual({ host: "192.168.0.102", via: "first" })
  })
  test("empty table → undefined", () => {
    expect(pickRunnerWsHost({ ifaces: [] })).toBeUndefined()
  })
})

describe("runnerDialHint", () => {
  test("a LAN address explains Local Network privacy and names the VPN fix", () => {
    const h = runnerDialHint({ url: "ws://192.168.1.130:19222", host: "192.168.1.130", via: "subnet" })
    expect(h).toContain("192.168.1.130 is a local-network address")
    expect(h).toContain("Local Network privacy")
    expect(h).toContain("Tailscale")
    expect(h).toContain("INTERCEPTOR_WS_URL")
  })
  test("a VPN address asks for the phone on the same VPN", () => {
    expect(runnerDialHint({ url: "ws://100.100.10.20:19222", host: "100.100.10.20", via: "vpn" })).toContain("same VPN")
  })
  test("override and loopback", () => {
    expect(runnerDialHint({ url: "ws://10.9.8.7:1", host: "10.9.8.7", via: "override" })).toContain("INTERCEPTOR_WS_URL is set")
    expect(runnerDialHint({ url: "ws://127.0.0.1:19222", host: "127.0.0.1", via: "loopback" })).toContain("simulator")
  })
  test("registrationFailure passes a pre-launch error through untouched (no runner was told to dial)", () => {
    const usbmux = "ios: device 'X' not visible to usbmuxd — plug it in over USB or put it on the same Wi-Fi as this Mac (a VPN such as Tailscale cannot reach the phone's pairing services)"
    expect(registrationFailure(new Error(usbmux), { url: "ws://100.100.10.20:19222", host: "100.100.10.20", via: "vpn" })).toBe(usbmux)
  })
  test("registrationFailure carries the timeout, the url, the rung, and the hint (no 'same network' advice)", () => {
    const msg = registrationFailure(new Error("InterceptorRunner did not register within 120s"),
      { url: "ws://192.168.1.130:19222", host: "192.168.1.130", via: "subnet" })
    expect(msg).toContain("did not register within 120s")
    expect(msg).toContain("was told to dial ws://192.168.1.130:19222 (subnet)")
    expect(msg).toContain("Local Network privacy")
    expect(msg).not.toContain("same network")
  })
})

describe("resolveRunnerDialBack", () => {
  const io = (over: Partial<DialBackIo>): DialBackIo => ({
    ifaces: () => REAL,
    phone: async () => ({ address: PHONE, interfaceIndex: PHONE_IFINDEX }),
    defaultRouteIface: () => "en0",
    env: {},
    ...over,
  })
  test("INTERCEPTOR_WS_URL override is first and reported as override", async () => {
    const d = await resolveRunnerDialBack("device", "U", 19222, io({ env: { INTERCEPTOR_WS_URL: "ws://10.9.8.7:1" } }))
    expect(d).toEqual({ url: "ws://10.9.8.7:1", host: "10.9.8.7", via: "override" })
  })
  test("simulator → loopback without touching usbmux", async () => {
    let asked = false
    const d = await resolveRunnerDialBack("simulator", "SIM", 19222, io({ phone: async () => { asked = true; return { address: PHONE } } }))
    expect(d).toEqual({ url: "ws://127.0.0.1:19222", host: "127.0.0.1", via: "loopback" })
    expect(asked).toBe(false)
  })
  test("device on this Mac → the Tailscale address (vpn)", async () => {
    expect(await resolveRunnerDialBack("device", "U", 19222, io({})))
      .toEqual({ url: "ws://100.100.10.20:19222", host: "100.100.10.20", via: "vpn" })
  })
  test("no VPN + the live usbmux link (IPv6 address, InterfaceIndex 24) → en1 via interface, not en0", async () => {
    const d = await resolveRunnerDialBack("device", "U", 19222, io({
      ifaces: () => [EN0, EN1, BRIDGE], phone: async () => ({ address: PHONE_V6, interfaceIndex: PHONE_IFINDEX }),
    }))
    expect(d).toEqual({ url: "ws://192.168.1.130:19222", host: "192.168.1.130", via: "interface" })
  })
  test("usbmux failure degrades to the next rung instead of throwing", async () => {
    const d = await resolveRunnerDialBack("device", "U", 19222, io({
      ifaces: () => [EN0, EN1], phone: async () => { throw new Error("usbmuxd down") },
    }))
    expect(d).toEqual({ url: "ws://192.168.0.102:19222", host: "192.168.0.102", via: "default-route" })
  })
  test("no usable interface → loopback", async () => {
    const d = await resolveRunnerDialBack("device", "U", 19222, io({ ifaces: () => { throw new Error("no os") }, phone: async () => undefined }))
    expect(d).toEqual({ url: "ws://127.0.0.1:19222", host: "127.0.0.1", via: "loopback" })
  })
})
