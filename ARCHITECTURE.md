# Interceptor — Architecture

This document describes the live architecture as of the current monitor, CSP-fallback, native-capture, multi-surface control (CDP / native runtime agent + hook fabric), and capability-blind extension-fabric implementation. It is not a tutorial — it explains *how the pieces fit*, with file references. For user-facing usage see `README.md` / `AGENTS.md`.

**Control surfaces.** Interceptor drives five surfaces, all brokered by the one daemon and addressed by `--context`: (1) the user's real **browser** (MV3 extension); (2) the macOS **bridge** (outside-in native control — AX, input, capture); (3) **CDP** for Electron/Chromium app web contents (`cdp:`/`app:`); (4) the in-process **native runtime agent** (`runtime:`); (5) the **iOS device** surface (`ios:<udid>`) — our own in-tree on-device XCUITest runner (InterceptorRunner) that dials INTO the daemon over WebSocket, launched over a pure-Bun developer channel (usbmux / lockdown / userspace RemoteXPC tunnel + testmanagerd on iOS 17+; no WebDriverAgent, no Xcode required). A **capability-blind extension fabric** lets operators add further surfaces without forking the product. The browser/monitor subsystems below are the oldest and deepest; the surface model and the fabric are documented in the *macOS bridge*, *CDP app control*, *Native Agent*, *iOS device surface*, and *Extension Fabric* subsections under **Other Subsystems**.

---

## High-Level Components

```
 ┌──────────────────────┐    Unix socket    ┌──────────────────────┐
 │ CLI (dist/interceptor)├─────────────────▶│ Daemon                │
 │  cli/commands/*.ts    │                  │ daemon/index.ts       │
 └──────────────────────┘                  └─────────┬────────────┘
                                                     │ native messaging stdio
                                                     │ + WebSocket fallback
                                                     ▼
                                          ┌─────────────────────────┐
                                          │ Browser WebExtensions     │
                                          │ Chrome / Brave / Safari   │
                                          │ extension/src/*          │
                                          │ (background SW + content │
                                          │  scripts + inject-net)   │
                                          └──────────────┬──────────┘
                                                         │ Unix socket
                                                         ▼
                                          ┌──────────────────────────┐
                                          │ macOS Bridge (Swift)     │
                                          │ interceptor-bridge/*     │
                                          │ (AX, CGEvent, Capture,   │
                                          │  Speech, Vision, NLP)    │
                                          └──────────────────────────┘
```

- **CLI** is a Bun-bundled standalone binary. It parses args, sends an action over `/tmp/interceptor.sock` to the daemon, and prints the response.
- **Daemon** is a singleton whose token is the WebSocket port (`19222`); `/tmp/interceptor.pid`, `.sock`, and `.lock` only describe the port owner, and the owner restores them if they go missing (see *Singleton ownership and self-heal* below). Spawned automatically by Chrome via native messaging, *or* started by the CLI on demand. It bridges CLI ⇄ extension ⇄ bridge, owns event persistence, and tracks per-session monitor artifacts.
- **Extension** is an MV3 service worker plus content scripts + a MAIN-world inject script. Chromium builds use `extension/src/background.ts`; Safari uses the native-relay `background-safari.ts` entrypoint inside a native containing app. Both own DOM capture, ref assignment, monitor session in-memory state, network monkey-patching, and scene-graph access for rich editors.
- **Bridge** is a Swift LaunchAgent-style daemon that exposes macOS-native capabilities (AX tree, CGEvent input, ScreenCaptureKit, AVFoundation audio, Vision/NLP frameworks).

### CLI-first browser install

- The primary repo install path builds `dist/interceptor`, `daemon/interceptor-daemon`, and `extension/dist/`, then runs `scripts/install.sh --brave --profile <profile>`.
- `scripts/install.sh` writes native messaging host manifests for Chrome and Brave, then launches Brave with `--load-extension=extension/dist`. If Brave is already running, the script prompts before quitting and relaunching it.
- Google Chrome branded desktop builds ignore `--load-extension`; the Chrome CLI path installs native messaging metadata, but the unpacked extension must be loaded manually from `chrome://extensions`.
- Safari ships as the separate notarized `Interceptor-Safari-<version>.pkg` containing app. Opening the app once registers its appex; the user then enables Interceptor in Safari Settings through Safari's protected user-presence gate. Until that approval, Safari does not start the worker and no `safari` context exists. Its stable daemon context is `safari` after connection.
- `interceptor macos trust` is a permission snapshot for native macOS automation. Browser runtime health should be checked through `interceptor status`, which confirms daemon, extension, and browser bridge state.

---

## Monitor Subsystem

The monitor is the most architecturally interesting subsystem. Several design iterations shaped its current form.

### Core concepts

A **session** is a user workflow (`SessionRecord`). A session has many sequential **attachments** (`AttachmentRecord`); only one attachment is "active" at a time (handoff, not fanout). An attachment is a `(tabId, documentId)` pair — keyed by document identity, not just tab identity, so reload / SPA pushState / BFCache restore all create new attachments cleanly.

Defined in [`extension/src/background/capabilities/monitor.ts`](extension/src/background/capabilities/monitor.ts).

```typescript
interface SessionRecord {
  sessionId: string
  rootTabId: number
  startedAt: number
  paused: boolean
  seq: number
  counts: { evt; mut; net; nav }
  attachments: Map<string, AttachmentRecord>
  activeAttachmentKey?: string
  lastTrustedAction?: TrustedActionRecord
}

interface AttachmentRecord {
  key: string                     // `${tabId}:${documentId}`
  tabId: number
  documentId?: string
  frameId: number
  url?: string
  openerTabId?: number
  attachedAt: number
  detachedAt?: number
  lifecycle?: string
  reason: "start" | "reload" | "history" | "fragment"
        | "child_tab" | "tab_replaced" | "focus_switch"
}
```

### Triggers that switch attachment

| Trigger | Source | Reason | Notes |
|---|---|---|---|
| `monitor_start` | CLI action | `start` | Initial attachment |
| `webNavigation.onCommitted` | top frame | `reload` / `start` | Hard nav or reload — new `documentId` |
| `webNavigation.onHistoryStateUpdated` | top frame | (no switch, URL update) | SPA pushState |
| `webNavigation.onReferenceFragmentUpdated` | top frame | (no switch, URL update) | Hash change |
| `webNavigation.onTabReplaced` | tab swap | `tab_replaced` | Prerender activation, etc. |
| `tabs.onCreated` + opener-gated heuristic | child tab | `child_tab` | child opened by trusted action on monitored tab within 5s |
| `tabs.onActivated` + group membership | manual focus | `focus_switch` | user activates another tab in the interceptor group |

`tabs.onActivated` short-circuits if `pendingChildTabs.has(tabId)` so the child-tab path always wins for child-tab cases.

### Privacy boundary

Focus-follow only attaches to tabs in a **managed tab group** — the default interceptor group or any named per-agent group (`isTabInAnyManagedGroup` in [`extension/src/background/tab-group.ts`](extension/src/background/tab-group.ts)). The user's personal tabs are never auto-attached. This boundary is preserved consistently across `tab new`, `tab switch`, and now focus-follow.

### Lifecycle events

Every attachment switch emits `mon_detach` (old) + `mon_attach` (new). Reasons:

| `mon_attach.reason` | Paired `mon_detach.reason` |
|---|---|
| `start` | (none — first attach) |
| `reload` / `history` / `fragment` | `document_replaced` |
| `child_tab` | `child_tab_handoff` |
| `tab_replaced` | `tab_replaced` |
| `focus_switch` | `focus_switch_handoff` |

Plus:

| `mon_detach.reason` | Where |
|---|---|
| `user_stop` | `monitor_stop` action |
| `tab_closed` | `tabs.onRemoved` |

### Durability — three layers

```
┌─────────────────────────────────┐
│  Extension memory (hot state)   │   sessions Map, activeSessionByTab
│  monitor.ts                     │   ephemeral; rebuilt on SW respawn
└─────────────────────────────────┘
                │ sendToHost (native port → daemon)
                ▼
┌─────────────────────────────────┐
│  Global rolling event log       │   /tmp/interceptor-events.jsonl
│  daemon emitEvent → appendFile  │   useful for `monitor tail`, rotates
└─────────────────────────────────┘
                │ daemon side-write per sid
                ▼
┌─────────────────────────────────────────────────────┐
│  Per-session artifact directory                      │   /tmp/interceptor-monitor-sessions/<sid>/
│  shared/monitor-artifacts.ts                         │     events.jsonl   — full session timeline
│  appendSessionEvent / appendSessionNetArtifact /     │     session.json   — metadata + attachment history
│  updateSessionMeta                                   │     net.jsonl      — persisted correlated bodies
└─────────────────────────────────────────────────────┘
```

`monitor export <sid>` prefers the per-session artifact and falls back to the global log only for legacy sessions (`hasSessionArtifacts(sid)` check in [`cli/commands/monitor.ts:93-99`](cli/commands/monitor.ts)).

**Task state (`shared/monitor-tasks.ts`).** The task envelope also serves as durable agent state across sessions. `monitor task create` makes a task with no recording; `task checkpoint <id> --file <json>` writes a revisioned record (owner, constraints, target `{contextId, group, tabId, frameId, origin}`, next action, lessons with `verified|unverified|superseded` status, and JavaScript checks) and rejects a stale `expectedRevision`; `task resume` returns the compact state plus only the lessons whose context and origin match; `task verify` evaluates the checks now in the page's MAIN world on the stored hard-scoped target after comparing the frame's origin, never reloads (`noCspReload`), and records `verification.passed` without touching lifecycle status; `task complete` runs the same checks and completes only when every one returns boolean `true`, exiting nonzero otherwise. Every metadata mutation goes through `withTaskLock`: a `.mutation.lock` holding the writer's pid, reclaimed only when that pid is gone and an exclusive reclaim claim is won (live, malformed, or contested locks fail with `task busy`), and the metadata file is replaced atomically by temp-and-rename. Over MCP, `resume` is read tier, `checkpoint` and the other writers mutate, and `verify`/`complete` are exec because they run author-supplied JavaScript.

### Transport resilience

`chrome.runtime.Port.postMessage()` throws synchronously if the port is disconnected (Chrome runtime docs). MV3 service workers can be evicted, native ports can disconnect, and `onDisconnect` is asynchronous — so there is a window where `nativePort` is truthy but calls on it throw.

[`extension/src/background/safe-port-post.ts`](extension/src/background/safe-port-post.ts) is a pure helper with zero chrome dependency that traps a synchronous `Port.postMessage()` throw. [`extension/src/background/transport.ts`](extension/src/background/transport.ts) wraps both `nativePort.postMessage` call sites through it; on throw it nulls the reference, downgrades `activeTransport`, and the caller falls through to the WebSocket channel.

`monitor_stop` (and `tabs.onRemoved`) wrap their `detachAttachment` + `sendToHost(mon_stop)` in `try` and run `sessions.delete` / `activeSessionByTab.delete` / `clearPendingChildTabsForSession` in `finally`. Cleanup is now guaranteed even if transport raises.

**Half-open WebSocket detection.** After MV3 service-worker hibernation the ws to the daemon can wedge OPEN-but-dead: outbound keepalives keep flowing while `ws.onmessage` is silently severed, so ws-forwarded actions never get a reply. The daemon answers each ws keepalive with a `keepalive_ack`; the extension counts keepalives sent since the last inbound frame (pure reducers in `transport.ts`, `wsStateOn*`) and, once an ack has ever been seen on the connection, forces a reconnect through the shared `closeWsForReconnect` teardown after `WS_KEEPALIVE_MISS_LIMIT` consecutive unacked keepalives (~40s). The ack gate is re-learned per connection, so a daemon that never acks (older build) can never trip a false-positive reconnect loop. This is deliberately application-level: Bun's protocol pings (`sendPings`) are answered inside the browser's ws stack and are invisible to extension JS, so they cannot drive client-side detection.

### Network body persistence

`extension/src/inject-net.ts` (MAIN world) monkey-patches `fetch` and `XHR`, dispatching `__interceptor_net` custom events with body + content-type. The content script's monitor listens for those events; when a fetch is correlated to a recent trusted user action (`cause`), it builds a redacted, capped preview (`buildBodyPreview` in [`extension/src/content/monitor.ts`](extension/src/content/monitor.ts)) and emits an enriched `fetch` / `xhr` / `sse` event with `bp` (body preview), `bt` (bytes), `trn` (truncated), `ct` (content type) fields.

Daemon-side `persistNetArtifactFromEvent` writes those bodies into `net.jsonl`. `monitor export --with-bodies` reads from `net.jsonl` first ([`cli/commands/monitor.ts:445-448`](cli/commands/monitor.ts)).

Caps: 64 KiB per entry, JSON / text / XML / JS content types only, conservative redaction of `Authorization` / `Cookie` / `Set-Cookie` / token-shaped strings / JWT-shaped tokens.

### Replay plan generation

[`buildPlan`](cli/commands/monitor.ts) walks the session events and emits a runnable `interceptor` script. Notable special cases:

- `mon_attach` with `reason === "child_tab"` → `interceptor tab new "<url>"` + `interceptor wait-stable`
- `mon_attach` with `reason === "focus_switch"` → `interceptor tab switch <tabId>` + `interceptor wait-stable`
- `mut` between two actions → inserts `interceptor wait-stable`
- `nav` with `typ === "hard" | "reload"` → `interceptor navigate "<url>"`
- masked password `input` → `# TODO` line
- correlated `fetch` / `xhr` with no persisted body → `# interceptor net log --filter ...` cue line

---

## Other Subsystems (Brief)

### Network capture

- **Passive (no CDP):** `extension/src/inject-net.ts` monkey-patches `fetch` and `XHR` in MAIN world. Content script's `extension/src/content/net-buffer.ts` keeps a rolling 500-entry buffer per page. `interceptor net log` reads it.
- **SSE:** `inject-net.ts` recognizes `text/event-stream` responses, dispatches per-chunk events; `net-buffer.ts` assembles streams.
- **Active (CDP-based):** `extension/src/background/cdp.ts` + `cdp-network-actions.ts` provide raw debugger network capture for cases where passive isn't enough. Shows the yellow infobanner — opt-in.
- **Reply budget:** a `net_log` reply crosses three 64 MiB frame caps (native messaging, the daemon WebSocket `maxPayloadLength`, the CLI frame guard), and an over-cap reply used to die as a silent transport timeout (issue #161). `budgetNetLogEntries` (`extension/src/background/capabilities/passive-net.ts`) keeps the newest entries' bodies up to 8 MiB of serialized content and blanks older bodies with `truncated: true`; url, status, and headers stay intact so counts and shapes are stable, and `--since` pages full bodies incrementally.
- **Exports:** `net log --format json|har|pcapng --out <path>` encodes through `shared/exports/index.ts`. Captured headers are kept by default; `--redact-auth` replaces credential-bearing values (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-CSRF-Token`, `X-API-Key`, and any `token` / `secret` / `session` header) with `[redacted]` on both request and response before encoding, which also empties HAR's derived cookie arrays. Files are written through `node:fs` at mode `0600` (`Bun.write` takes no mode) with an explicit `chmod` so a pre-existing file is tightened too (issue #160).

### Frame-aware read surfaces

`interceptor read --include-frames` is routed by `cli/commands/compound.ts` to `frames_read_tree` in `extension/src/background/capabilities/frames.ts`. The background handler uses `chrome.webNavigation.getAllFrames({ tabId })`, sends `get_a11y_tree` into each reachable frame, and rewrites non-top refs from `[eN]` to `[e<frameId>_<N>]` before returning the combined tree.

Framed refs are round-trippable. `parseElementTarget` preserves `frameId` and `ref`, `buildReadTreeAction` passes them into `frames_read_tree`, and the frame handler filters to the requested frame before asking the content script for the subtree. Content-side `get_a11y_tree`, `extract_text`, and `extract_html` accept both `index` and `ref`, so `interceptor read e22_1 --tree-only --include-frames` returns the child-frame subtree instead of the whole multi-frame page.

### Browser-provider web search

`interceptor websearch "<query>"` is a compound browser operation rather than a page-content search. The CLI validates the query before daemon startup, capability-checks `chrome.search.query`, and then allocates or reuses a tab through the same `tab_create` lifecycle used by `open`. The allocator's `prepareOnly` mode preserves a reused tab until the provider navigation begins while retaining named-group isolation, background-first creation, reuse policy, group warnings, and the per-group auto-target.

After allocation, `search_query` is dispatched against the validated tab as `chrome.search.query({ text, tabId })`; it never supplies a `disposition` or hard-codes a provider. The CLI waits for the browser's configured provider page to stabilize, reports the actual URL/title and tab/group/reuse metadata, and returns the normal tree/text read shapes. An unsupported browser fails before allocation. A dispatch failure closes only a tab that was created for the request and is still blank; reused tabs are never failure-cleaned. The former `search` spelling is a warning alias over this same path and is intentionally absent from primary discovery.

### Current-page find

`interceptor find "<query>"` stays entirely inside the loaded document and never navigates, creates a tab, focuses, scrolls, highlights, or mutates. The content handler takes one `document.body.innerText` snapshot and runs two independent matchers: a literal case-insensitive rendered-text scan over the complete snapshot (not `read`'s normal output cap), and the existing accessible-element scorer over the ref registry. Results remain typed as text and elements because source indices/snippets and actionable ref scores are not one comparable ranking. `--text-only`, `--elements-only`, and `--role` narrow the enabled categories; limits cap returned matches while totals and truncation remain truthful.

`find --include-frames` routes to `frames_find`, which uses the same `webNavigation.getAllFrames` fan-out as frame-aware reads, aggregates totals globally, labels matches with their frame id, and rewrites child element refs to `e<frameId>_<N>`. Opaque or unreachable frames are reported without discarding successful results from reachable frames. Element matches in a child frame depend on that frame's normal ref registry; `read --include-frames` is the standard way to populate actionable framed refs before an element-only find.

### Selector-targeted actions and the query→ref bridge

Some pages return an empty accessibility tree while their DOM is fully queryable, which used to make them visible to `query` but unclickable. Two complementary lanes close that gap. `interceptor click --selector "<css>" [--nth N]` (`click_selector` action) clicks the Nth `querySelectorAll` match directly, with honest errors carrying the match count for zero/out-of-range/invalid selectors. And `query` assigns every returned element a ref via `getOrAssignRef` — the same element-keyed registry the a11y tree uses — so DOM-discovered elements are actionable by every ref verb (`click e<N>`, `type e<N>`, …). Selector clicks report the clicked element's ref both in the message and as a structured `refId`, which the background router uses to join the synthetic→`os_click` auto-escalation lane on "no DOM change", resolving screen coordinates from the ref exactly like a ref-targeted click. `parseElementTarget` itself guards missing targets with a usage error (it previously threw), and malformed `--selector`/`--nth` values are rejected at parse time rather than falling through as bogus refs.

**Click outcome detection.** Every click lane (`click`, `click --selector`, `scene click`) registers its 200 ms `MutationObserver` *before* dispatching the synthetic click sequence, because handlers mutate synchronously and an observer installed afterwards missed them: the first click after a page load read as "no DOM change" three times out of three while the handler had run, which escalated to an OS click that the foreground guard refused on a background tab and surfaced as `click failed at all layers`. `content.ts` now appends its dirty-state note to the action's own warning instead of replacing it, and `router.ts` returns the synthetic success plus the warning when the OS escalation was refused by the guard (`data.hint` present, `--os` not requested), keeping `failed at all layers` for real OS failures.

### Trusted OS input (`--trusted`) — foreground delivery gate

`--trusted` (back-compat alias `--os`) posts real CGEvents from an HID-state source: the extension computes page→screen coordinates and the daemon posts them to the global HID tap (`CGEventPost(kCGHIDEventTap)` in [`daemon/os-input.ts`](daemon/os-input.ts)), which macOS routes by screen position and window z-order — not by tab or process. Delivery is therefore only correct when the target tab is the visible tab of the OS-focused window, so all four `os_*` verbs (`os_click`, `os_move`, `os_type`, `os_key`) run a foreground preflight in [`extension/src/background/capabilities/os-input.ts`](extension/src/background/capabilities/os-input.ts): resolve the owning window via `chrome.tabs.get(tabId)` → `chrome.windows.get(tab.windowId)` — never `chrome.windows.getCurrent()`, which in an MV3 service worker is the *last-focused* window and was the original mis-aim of issue #166 — then refuse with an actionable `hint` unless the tab is active in its window and that window is OS-focused and non-minimized. `windowBounds` on the success path always comes from the owning window. The refusal is contract, not limitation: Chromium only accepts web-content mouse events in the active window (`acceptsFirstMouse:` defaults to `kWhenInActiveWindow`), so a background trusted click would either be swallowed-to-activate (a focus steal the background-first contract forbids) or, worse, land in whatever is frontmost while still reporting success. The verbs refuse rather than move focus — `--trusted` stays off the focus-moving exception list — and the synthetic→`os_click` auto-escalation lane surfaces the same refusal (`os_error` + hint) in its layered diagnostics. Foregrounding is the caller's explicit opt-in (`tab switch <id>` / `window focus <id>`); note that `tab switch` alone does not transfer macOS app focus when another app is active — `macos app activate "<Browser>"` is the reliable pre-step.

### Canvas observability

`extension/src/inject-canvas.ts` runs in MAIN world and wraps canvas APIs such as `getContext`, `fillText`, `strokeText`, `fillRect`, path drawing, and image drawing. It stores a page-local observer under a non-enumerable `Symbol.for()` key on `window` (see *MAIN-world identifier hardening* below) with three buffers: raw operation log entries, derived objects, and registered canvas metadata. HTML canvas metadata includes DOM order as `domIndex`, which is the index shown by `interceptor canvas list`.

`extension/src/background/capabilities/canvas.ts` exposes the CLI-facing canvas actions. `canvas status` combines DOM canvas discovery with host/app-model signals. `canvas log [N]` and `canvas objects [N]` execute self-contained summary functions **in the page-canonical MAIN-world realm via `chrome.userScripts.execute`** — the same realm where `inject-canvas` installs the observer and the page's own drawing accumulates. Reading it through `chrome.scripting.executeScript`'s MAIN world instead lands in a separate realm whose observer is present but empty, so the summaries would return nothing while the page was actively drawing; `chrome.userScripts.execute` (with `chrome.scripting.executeScript` as a fallback for DOM-only readers) reads the live buffers. The summaries resolve DOM canvas index `N` to the observer's internal `canvasId` (an absent *or null* index means *all canvases*), then filter logs or derived objects to that canvas. This keeps multi-canvas pages separated while preserving global queries when no index is supplied.

`canvas model` inspects host-specific state such as hidden Google Docs mirrors and Excalidraw-like globals/localStorage. `canvas routes` ranks passive network entries that look like canvas/editor persistence routes. `canvas read` exports pixels from DOM or WebGL canvases; `canvas ocr` is present but should be treated as experimental until its offscreen OCR path is revalidated.

### MAIN-world identifier hardening

The scripts injected into the page's MAIN world (`inject-net.ts`, `inject-canvas.ts`) and the MAIN-world helpers run from the background (`evaluate.ts`, `binary-sink.ts`) share the page's globals, so any string-named property they set on `window` / `navigator` / a prototype is enumerable by the page. Install guards, the canvas-observer handle, and the prototype-patch flags are therefore keyed with `Symbol.for()` — a realm-shared registry, so the guards still de-duplicate across re-injection — instead of vendor-named string properties. Symbol keys are excluded from `Object.keys`, `for…in`, `JSON.stringify`, and `getOwnPropertyNames`, so a page can no longer fingerprint the extension with a one-line window-key scan, and the Trusted-Types policies are created under non-attributable names. The shared string constants live in [`extension/src/inject-keys.ts`](extension/src/inject-keys.ts) and are re-derived with `Symbol.for()` inside the `chrome.scripting.executeScript` / `chrome.userScripts.execute` function bodies (which are serialized and run with no lexical scope, so an imported symbol would be a free identifier). This is hardening, not invisibility: `Object.getOwnPropertySymbols(window)` still lists the keys and their opaque descriptions. The cross-world `CustomEvent` channel (`__interceptor_net`, `__interceptor_headers`, …) and the documented `event.__interceptor_trust` input marker are intentionally unchanged.

### Page-world eval on strict-CSP sites

`extension/src/background/capabilities/evaluate.ts` now treats page CSP as a first-class runtime concern. On a `MAIN`-world eval failure that matches a CSP/`unsafe-eval` pattern, it installs a tab-scoped **session** `declarativeNetRequest` rule that strips `content-security-policy` and `content-security-policy-report-only`, reloads the tab, then retries once. This is the behavior proven against OpenStreetMap during live validation.

`extension/src/background/capabilities/meta.ts` also exposes `userScripts` capability diagnostics so live validation can distinguish between the `userScripts` route and the CSP-bypass fallback.

**Honest results on the `userScripts` route.** `chrome.userScripts.execute` returns `{frameId}` with neither `result` nor `error` when the script throws or fails to parse, so a bare `throw new Error("x")` used to come back as `success: true, data: null`. `executeWithUserScripts` now wraps the code textually (no `eval`): an expression form first (async IIFE, `try/catch`, structured clone of the value), then a statement form (top-level `try/catch` that keeps the completion value and sets a nonce flag on `globalThis[Symbol.for("interceptor.eval.ran")]`), then a probe that tells a legitimate `undefined` (flag set) from a script that never parsed (flag unset), then an async-body form for top-level `await`/`return`; only when nothing ran is a `SyntaxError` reported. Throws, rejections, and `ReferenceError`s exit 1 in both worlds. The Trusted-Types-only isolated-world retry was removed because it silently changed the world the caller asked for; the MAIN CSP strip-and-reload is the only CSP recovery, the result discloses it, and task verification passes `noCspReload` so a blocked check stays a failed check. Both injection paths (`scripting.executeScript` and `userScripts.execute`) honor `--frame` through `target.frameIds`; a missing frame fails instead of running in the top frame.

### Scene graph (rich editors)

`extension/src/content/scene/` provides per-host resolvers for Canva (LB layer ids), Google Docs (hidden text-event iframe + `data-ri` offsets), and Google Slides (filmstrip SVG + blob URLs). `interceptor scene profile` detects the host; `interceptor scene list / click / text / insert / slide` operate on the resolver.

### Tab group isolation

[`extension/src/background/tab-group.ts`](extension/src/background/tab-group.ts) maintains the default "interceptor" tab group (runtime-brandable title/color via `interceptor brand tab-group`). By default all interceptor commands operate only on tabs in managed groups; `--any-tab` opts out. Focus-follow respects this boundary.

**Working-tab resolution** — the dispatcher resolves every request's working tab through [`extension/src/background/resolve-tab.ts`](extension/src/background/resolve-tab.ts): a well-formed explicit `action.tabId` (the `tab close <id>` / `tab switch <id>` argument) beats the `--tab` override (`msg.tabId`), which beats the stored auto-target / group tabs / browser-active fallback. The group gate therefore always validates the same tab the handler acts on. The auto-target is written exactly once per request, **after** the gate passes — there is no pre-gate persist, so a gate-rejected request (e.g. the browser-active tab is unmanaged) cannot poison the stored target for subsequent commands, and handlers do not write the auto-target themselves. All auto-target storage goes through a session-or-local fallback (`chrome.storage.session` is MV3-only; the MV2 Electron package shares these handlers). The CLI accepts tab ids only as strict numeric first non-flag arguments. Invariants are pinned by `extension/src/background/resolve-tab.test.ts` and `test/tab-id-args.test.ts`, and codified in `.agents/rules/tab-target-contract.md`.

### Named per-agent tab groups

Multiple agents can share one browser context without touching each other's tabs. `--group <label>` or non-empty `INTERCEPTOR_GROUP` hard-scopes an invocation to a named group rendered as `<brand>-<label>` on the tab strip with a deterministic per-label color (`--group-color` overrides). Hard scope keeps resolution and targets inside that group by default; `--any-tab` is the explicit escape hatch. Without an explicit scope, supported agent shells get a soft automatic group. `INTERCEPTOR_SESSION_ID` is the neutral contract, followed by verified Maestro, Claude Code, and Codex adapters. The CLI hashes the full id with SHA-256, exposes only `s-` plus 16 hexadecimal characters, and marks the action `groupSoft`. Soft scope homes tab creation, policy reuse, and idle cleanup without becoming an isolation boundary: an empty session group can fall back to the active managed tab. `--shared-group` or set-but-empty `INTERCEPTOR_GROUP=` suppresses automatic scope and uses the shared default Interceptor group. Concurrent lanes often inherit one session id, so each lane still needs a unique explicit label or neutral session id:

- **Registry** — `tab-group.ts` keeps a `label → groupId` map mirrored to `chrome.storage.session`, whose lifetime exactly matches Chrome's session-scoped group ids. Group creation is serialized per label (concurrent creators join one group instead of minting duplicates), and a `tabGroups.onRemoved` listener purges registry entries when a group is closed — by an agent or by hand.
- **Scoped dispatch** — each group has its own auto-target key (`activeTabId:<label>`). Hard explicit scopes resolve within their group (stored target → most-recent group tab → error) and require caller-group membership unless `--any-tab` is authorized. Soft automatic scopes may fall back to another managed tab. The auto-target is persisted only after the applicable gate passes. Shared-default requests require membership in any managed group, preserving single-agent behavior.
- **Lifecycle** — `interceptor group list` reports every live group (label, title, color, tab count); `interceptor group close <label>` closes exactly that group's tabs in one atomic `tabs.remove`. Closing one group never affects another, so a human can clean up after a dead agent while others keep running.
- **Group identity travels inside the action payload** (`action.group`), injected at the CLI transport choke point — the daemon relays it untouched, and browsers without the `tabGroups` API (the MV2 Electron bridge, Firefox) degrade gracefully to ungrouped behavior.
- **Normal-window placement** — `tab_create` resolves a groupable *normal* window up front (`resolveNormalWindowPlacement` in `capabilities/tabs.ts`: focused normal → first normal → create one). Without it, `chrome.tabs.create` inherits whatever window last had focus — a popup/devtools/app window whose tabs `chrome.tabs.group` rejects. When a window must be created it carries the target url, and its initial tab *is* the requested tab (an empty window would ship a New Tab Page and leave an orphan next to the real tab). Grouping itself is tolerated-to-fail (guarded `chrome.tabs.group`, non-normal windows skipped), but failure is surfaced: when the group API exists and the tab still couldn't be grouped, the result carries a `groupWarning` — a silent `-1` would let two agents' tabs share a pile while both believe they're isolated.
- **Monitor integration** — child tabs inherit their opener's group, and monitor auto-attach accepts any managed group.

### Tab lifecycle policy (reuse + idle sweep)

[`extension/src/background/tab-lifecycle.ts`](extension/src/background/tab-lifecycle.ts) enforces cleanup so long automation runs stop accumulating tabs. Two knobs live under one `chrome.storage` key (`tabLifecycle`), resolved `managed > local > default` exactly like the brand identity (defaults: `reuse: true`, `idleCloseMinutes: 10`); the extension popup is the only writer.

- **Named-group reuse by default** — `open --group <label>` navigates that group's most-recent tab instead of creating one (address-bar semantics; `--no-reuse` forces a new tab). The policy engages **only for named groups**: in the shared default group "most recent tab" can be a sibling agent's, so ungrouped `open` always creates, and explicit `--reuse`/`--no-reuse` always wins (`policyMayDecideReuse`). `tab new` is the ⌘T verb — it never consults the policy and both verbs share one parser (`buildTabCreateAction`), which also fixed `tab new --reuse` being silently ignored.
- **Idle sweep** — tab-touching dispatches stamp `groupLastSeen:<label>` in `storage.session`, with the same lifetime as the group ids it describes. Metadata polls such as `status` and `group_list` do not count as tab activity and do not keep a group alive. A `chrome.alarms` tick (1 min, existence-checked on every SW startup because alarms may not survive browser restarts) closes any managed group idle past the configured minutes. Guards, in order: only managed groups are ever touched; never the focused window's active tab (unknown focus protects every active tab); never pinned; never audible; never a window's last tab (`selectSweepCandidates`, pure and unit-tested); and never a tab with unsaved user state. `chrome.tabs.remove` was proven live to bypass `beforeunload` entirely (handler never runs, no dialog), so the sweep injects a dirty-state check (form deltas vs. defaults, `window.onbeforeunload` registered) and keeps dirty tabs for the agent's own `group close`. Missing stamps grace-stamp instead of closing; survivors re-stamp so a guard-vetoed group isn't re-scanned every tick. Sweeps log to `storage.local` (`tabLifecycleSweepLog`, capped) and the SW console; swept tabs remain restorable via `sessions restore` / ⌘⇧T.
- **Observability** — the extension `status` action returns the resolved policy + source tier (`tabLifecycle: { reuse, idleCloseMinutes, source }`), rendered by `interceptor status --verbose`.
- **Restore semantics** — Chrome's session store records tab/group closes inside a surviving window as individual closed-tab entries (each remembers its `groupId`, so restoring them reassembles the group), while a whole-window close is a single restorable `window` entry. `sessions restore` therefore requires an explicit sessionId — the no-arg "most recently closed" form is refused, since it can grab the user's own window.

### Self-update (`interceptor update`)

Top-level front door for updating Interceptor itself. On macOS it is sugar for the retained (undocumented) `macos update check`, a user-initiated `SPUUpdater.checkForUpdates()` via the bridge's `UpdateDomain`. `main.swift` injects one `SparkleUpdateState` into both `UpdateDomain` and `SparkleUpdaterDelegate`: the domain waits up to 10 seconds, while delegate callbacks record the selected item, no-update reason, user choice, download/extraction/install phase, cycle end, and real error. The command therefore returns an observed `update_available`, `up_to_date`, `no_eligible_update`, or `error` result; a slower feed returns `checking` without promising an alert, and `update status` exposes the later result plus Sparkle's schedule fields. The state is intentionally process-local and observational. It does not alter appcast selection, cached installers, or installation policy. On Windows there is no Sparkle: the command skips the surface gate and daemon entirely and prints the signed-installer guidance + Releases link. Browser-only macOS installs get the `upgrade --full` hint (the updater lives in the bridge app). A found update's Sparkle alert is a window the bridge itself owns, so an agent drives it with the ordinary compound verbs (`interceptor macos read --app interceptor-bridge`, `interceptor macos act <ref>`); see the self-targeted marshal below for why that is safe. Every published update is a `package` (guided pkg) install, and Sparkle's installer launcher always requests administrator authorization for that type, so the final step is a user-present password prompt by design. An unattended `update --install` verb is not possible on this feed.

### CLI argument contract (`cli/normalize.ts`)

Every browser-surface command's argv is rewritten to `[cmd, ...positionals, ...flags]` before dispatch, so flag position never changes meaning (`open --text-only <url>` ≡ `open <url> --text-only`), `--flag=value` splits into `--flag value`, and `--` terminates flag parsing. Two per-family tables drive this and together form the contract: `VALUE_FLAGS_BY_CMD` (flags that consume the next token) and `BOOLEAN_FLAGS_BY_CMD`. A value flag missing from its table has its operand hoisted into the positionals (this is how `window resize --width 800` misparsed the width as a window id), and a flag missing from both tables is **rejected** — `unknown flag '--x' for '<cmd>'`, exit 1 — instead of silently ignored (issue #212: `screenshot --out <path>` wrote nothing and exited 0; the rejection names `--save` for that case). `INTERCEPTOR_LAX_FLAGS=1` downgrades the rejection to one stderr warning. `normalizeArgsSplit` also returns the positional count so text-sweeping parsers consume only the positional span: `type <ref> <text> --frame <id>` used to type `"<text> --frame <id>"` because the `type` parser swept every remaining token (issue #217). `test/strict-flags.test.ts` enforces the contract in both directions: every declared flag must parse, and a reverse-direction harvest reads each command module's source (`includes`/`indexOf`/`flagPresent`/`flagValue`/`hasTrustedFlag` consumption sites) and fails CI on any consumed flag missing from the tables — including flags routed through shared helpers, which a literal-grep harvest once dropped (`act --trusted`/`scene click --trusted` were rejected at runtime in 0.23.23–0.23.25 while their help still advertised them; restored in 0.23.27). `macos`, `ios`, `mcp`, and `update` are not normalized (verb-first grammars with per-subverb flag semantics) and are therefore not strict. `--frame` is a global browser flag: `parseFrameFlag` accepts it before or after the command (and `--frame=N`), `filterGlobalFlags` strips it from browser argv so it can never enter `eval` code or `type` text, and the native grammars never receive it. `eval` builds its JavaScript from the positional span only, so `eval '1+1' --json` evaluates `1+1`. `act` takes the ref directly (`act e5`, not `act click e5`) and separates a validation failure (nothing was sent) from a timeout or closed channel after dispatch, which it reports as unverified delivery so the caller reads before retrying instead of clicking twice.

**Exit codes follow the result.** A browser-surface command whose result is `success: false` prints `error: …` (or the JSON envelope under `--json`) **and exits non-zero**. Until 0.23.40 only the compound verbs (`open`/`read`/`act`/`inspect`) and a few hand-rolled handlers did this; every generic action — `back`, `forward`, `navigate`, `scroll`, `cookies`, `eval`, … — went through one shared print at the tail of `cli/index.ts` that never mapped the failure to the exit code, so `interceptor back` printed Chrome's `Cannot find a next page in history.` and exited 0 (issue #237). The guard now lives at that single print (`process.exitCode = 1`, so stdout drains and the transport closes normally), and the compound JSON path was aligned with it. `test/cli-exit-code.test.ts` runs a real daemon with a fake extension to pin the contract end to end.

**`back`/`forward` drive the page's own history when the tabs API refuses (issue #237).** `chrome.tabs.goBack`/`goForward` reject with `Cannot find a next page in history.` for any entry marked skippable by Chrome's history-manipulation intervention, and Chromium treats extension-initiated navigations (`tabs.create`, `tabs.update`) as renderer-initiated without a user gesture — so every entry Interceptor itself produced is unreachable through the API, while `history.go()` from inside the page still steps over it (verified live). `historyGo()` in `capabilities/navigation.ts` tries the API first, falls back to a page-side `history.go(±1)` via `chrome.scripting.executeScript`, and confirms the tab moved (URL change or `loading`) before reporting success; a tab with nothing to go to still gets an honest error.

**Windowless profiles (issue #162).** A profile whose extension is connected but which has no windows makes `chrome.tabGroups.query({})` and `chrome.tabs.query({ currentWindow: true })` reject with `No current window`. The group helpers treat that as "no groups" so `tab_create` reaches `resolveNormalWindowPlacement` and creates the window (background, unfocused unless `--activate`), `tabs` answers `[]`, and tab-targeted verbs fail with `no browser window is open in this profile — 'interceptor open <url>' creates one in the background` instead of Chrome's bare error.

### Transport routing (daemon)

The daemon talks to the extension via three channels, routed by [`daemon/outbound-routing.ts`](daemon/outbound-routing.ts):

- **Native messaging stdio** — when daemon was spawned by Chrome
- **WebSocket** (`ws://localhost:19222`) — fallback / preferred for action requests
- **Native relay** — secondary daemon instances become transparent stdin/stdout bridges to the singleton (eliminates the every-30-second native-host disconnect noise; introduced in [#28](https://github.com/Hacker-Valley-Media/interceptor/pull/28))
- **Safari native relay** — Safari's service worker long-polls its containing appex with `runtime.sendNativeMessage`; the appex owns a `URLSessionWebSocketTask` to `127.0.0.1:19222` and relays the unchanged command/response envelope

#### Singleton ownership and self-heal

Exactly one process can bind the WebSocket port, so the port is the daemon's authoritative singleton token (fix #104); the pid file, the CLI socket, and the lock file are derived state written only after the port is won. Every decision that used to be made from the pid file alone now asks the port first through `GET /health` (`shared/daemon-health.ts`): a starting daemon (`bootstrapDaemonRole`) relays or exits while the port is held and never clears the owner's files, the CLI (`ensureDaemon`) never unlinks or spawns while the port is held, and the pkg postinstall removes runtime files only for a dead pid. The owner answers `/health` with `{service: "interceptor-daemon", pid, version, wsPort, healed}` and, in the course of answering (and on its 10 s keepalive tick), rewrites a missing or foreign pid file, rewrites a missing or foreign lock with its original shutdown token, and re-listens on a missing unix socket path (Bun's `stop()` never unlinks the path, so the orphaned listener is stopped after the new one is up and in-flight CLI connections finish). This closes the "daemon failed to start" deadlock (PR #227): a stale-pid guess by a Chrome-spawned host or by the CLI used to wipe a healthy daemon's files, after which every respawn lost the port to the survivor. A pre-heal daemon answers every path with the text `interceptor daemon`; the CLI recognizes that as `legacy` and fails closed with the kill recipe instead of spawning a rival. Exit-path cleanup is additionally gated on gate ownership (`cleanupOwnedRuntimeFiles`, PR #227), which is defensive today because every process that reaches the exit hook has already won the gate.

**Idle-spin watchdog (issue #216).** A standalone daemon was reported at ~100% CPU for hours with no clients and nothing new in the log. The cause is not known, so the daemon does not claim a fix; it makes the state visible, retains evidence, and self-heals. On each 10 s keepalive tick it measures `process.cpuUsage()` since the previous tick (`daemon/spin-watchdog.ts`, pure). When the process is busy (≥ 85 % of the tick) while it has nothing to do — no CLI sockets, no registered contexts, no native relay, nothing in flight — it logs `spin watchdog: N% CPU …` plus rss and emits a `daemon_spin_detected` event; after six consecutive such ticks (60 s) it logs, emits `daemon_spin_exit`, and shuts down so the next CLI call or native-host connect respawns a fresh daemon. Before that exit, `captureSpinSample()` runs `/usr/bin/sample <pid> 1 10` into a `0600` file under a fresh `interceptor-spin-*` directory beside the daemon log (macOS only, 15 s cap, a failure never blocks recovery) and logs the path, so the next occurrence leaves a stack sample behind. `INTERCEPTOR_SPIN_WATCHDOG=off` disables it. Limit: it runs on the event loop, so it catches event-loop-level spins (timer storms, socket poll loops) but not a JS busy-loop that blocks the main thread.

The lock file is owner-only before its temporary file is atomically renamed into place. Unix applies mode `0600`; Windows resolves `whoami.exe` and `icacls.exe` from `%SystemRoot%\System32` (falling back to `%windir%` and then `C:\Windows`) instead of consulting `PATH`, so a Git Bash `whoami.exe` cannot shadow the Windows SID lookup (issue #231). ACL setup failures remove the temporary file, include the absolute system-tool failure detail, and are logged at daemon startup before the error is rethrown.

Safari uses the Safari native relay because public `WKWebExtension` probes showed that its background JavaScript did not open a direct loopback WebSocket, even with both `localhost` and `127.0.0.1`. `background-safari.ts` calls `configureTransport({ contextId: "safari", safariNativeRelay: true })` before opening the relay and optional capabilities. One-shot native messages carry a bounded long-poll exchange; `SafariWebExtensionHandler.swift` keeps the daemon WebSocket alive between exchanges. Safari-absent APIs degrade locally. The shared action router is import-safe: entrypoints call `initializeActionRouter()` explicitly, preventing a missing WebExtension event from becoming a background-content load failure before registration.

Two Safari-specific behaviors live above the transport. **Navigation acknowledgment:** Safari can unload a content script before delivering its async `sendResponse` when a click starts a navigation, leaving the message channel pending. `content-bridge.ts` treats a loading/url update on the exact target tab as the acknowledgement for click-like actions (`click`, `click_at`, `dblclick`, `find_and_click`, `click_selector`), so a navigating click resolves as `{navigated: true, url}` instead of hanging or replaying against the new document (this also hardens Chrome). Beyond navigation, the bridge distinguishes **delivery failure** ("Receiving end does not exist" — no receiver, safe to retry anything) from **response loss** (closed channel / disconnected port after delivery): input-like actions (clicks, typing, keys, check, upload — `INPUT_ACTIONS` in `shared/content-script-retry.ts`) are never blindly re-executed on response loss, returning a delivered-but-unconfirmed result instead, while reads keep the aggressive re-inject-and-retry path that fresh tabs depend on. **Header modification:** DNR `modifyHeaders` rules declare an explicit `resourceTypes` set (omitting it excludes `main_frame`, so top-level requests are never rewritten on any browser), and the Safari manifest requests `declarativeNetRequestWithHostAccess`, which Safari requires for `modifyHeaders`/`redirect`. Safari additionally restricts modification to recognized standard header names; arbitrary custom headers are rejected at rule registration and must be rewritten through the MAIN-world override path instead.

#### Named contexts (multi-browser isolation)

The daemon tracks all connected extensions in `extensionWsMap: Map<string, WebSocket>` rather than a single scalar. Chrome/Brave profiles generate a UUID and persist it in `chrome.storage.local`; Safari uses the fixed id `safari`, and its registration does not depend on storage being available. The id is announced in every WebSocket registration message `{ type: "extension", contextId: "<id>" }`; for Safari, the appex sends that registration over its relay-owned socket.

CLI commands carry an optional `contextId` field in the IPC message. `sendNativeMessage` resolves the target WebSocket by:
1. Exact `contextId` match from the map (when `--context <id>` is passed)
2. Any single connected extension (if the map has exactly one entry)

If no `contextId` is provided and zero or multiple extensions are connected, the daemon returns a fail-fast error instead of guessing a profile.

Per-context outbound queues (`wsOutboundQueues: Map<string, string[]>`) replace the old global array; messages queued before the extension connects drain to the correct context on registration.

`interceptor contexts` lists all connected context IDs. Use `--context <id>` on any command to route it to a specific profile.

#### Message framing and large payloads (file upload)

CLI↔daemon IPC and the daemon↔extension channels use length-prefixed frames (a 4-byte little-endian length followed by JSON). Two rules keep large frames intact:

- **Backpressure.** `socket.write()` on a raw Bun socket buffers nothing: it returns the byte count the kernel accepted and silently leaves the rest with the caller. On macOS the unix-socket send buffer is 8 KiB (`net.local.stream.sendspace`), so a single bare write of a larger frame partially writes even on an idle socket; the dropped tail desyncs the peer's length-prefixed reader, which then consumes the *next* frames' bytes as the missing tail — one oversized message poisons every message behind it (issue #229). Every raw-socket writer in the daemon therefore routes through `daemon/socket-write.ts`: `socketWriteAll` appends to the socket's queue when bytes are already pending (never writing ahead of a queued tail, which would interleave frames), otherwise writes and queues the unwritten remainder; `drainSocketQueue` flushes in order from the socket's `drain` handler; `releaseSocketQueue` drops the queue on close. Adopters: `socketWriteFramed` (CLI responses), `sendToBridge` / `forwardDelegateToBridge` (daemon→bridge), the native relay (registration + Chrome→singleton stdin forward), and the usbmux forward pump (`daemon/ios/usbmux-forward.ts`, both legs). The CLI side does the same in `sendCommand` (`cli/transport.ts`). One-shot sub-8 KiB control writes on fresh sockets stay bare — they cannot exceed an empty send buffer. The bridge→daemon direction needs no queue: the Swift bridge's accepted fds stay blocking, so its `write(2)` completes fully. node:net sockets (iOS tunnel helper, lockdown channels) self-buffer and are exempt.
- **Frame ceiling.** The IPC readers accept frames up to `MAX_UPLOAD_FRAME_BYTES` (`shared/platform.ts`). An oversized frame is dropped, but the request id is recovered from the buffered prefix so the caller gets an honest "payload too large" error instead of a silent timeout.
- **Honest timeouts.** When a browser-lane request times out, the CLI asks the daemon for its connected contexts first (`probeContextCount` in `cli/transport.ts`: a 1.5 s one-shot `contexts` request answered from the daemon's connection table, never touching the extension). If a context is attached, the error says so and points at response size (`--limit`, `--since`, `--filter` for `net_log`) instead of the "Ensure Chrome/Brave is open" hint, which is provably wrong in that state (issue #161). Bridge, iOS, and upload lanes keep their tailored hints without the probe.
- **Stale-snapshot hint.** A background router older than the CLI forwards unrecognized action types to the content script, which answers `unknown action type: <t>`; the CLI labels that reply with a hint to run `interceptor reload`, because a running browser keeps the previous service worker until the extension reloads.

**File-upload transport.** `interceptor upload` ships file bytes base64-encoded. Above `UPLOAD_CHUNK_B64_BYTES` the CLI splits the payload into sequential `file_upload_chunk` actions sharing an `uploadId`; the content script buffers them and a final `file_upload` assemble message reconstructs the file. Each chunk stays under the browser's ~1 MiB native-messaging host→extension limit, so uploads work on every daemon↔extension transport, not just WebSocket. The content handler prefers setting a resolved `<input type=file>`'s `.files` (which is `isTrusted`-independent), then falls back to a trusted synthetic drop and a File System Access `showOpenFilePicker` shim; every path returns a `verified` flag rather than claiming blind success.

### macOS bridge

[`interceptor-bridge/`](interceptor-bridge/) is a Swift Package binary launched as a LaunchAgent. It exposes:

- AX tree + CGEvent input (`AccessibilityDomain`, `InputDomain`, `AppsDomain`, `MenuDomain`)
- ScreenCaptureKit (`CaptureDomain`, `StreamDomain`, `DisplayDomain`)
- AVFoundation + speech + sound classification (`SpeechDomain`, `SoundDomain`, `AudioDomain`)
- Vision + NLP + on-device LLM (`VisionDomain`, `NLPDomain`, `IntelligenceDomain`)
- File watch / notifications / clipboard (`FilesDomain`, `NotificationsDomain`, `ClipboardDomain`)
- Sensitive content + log query + container + URL fetch (`SensitiveDomain`, `LogDomain`, `ContainerDomain`, `NetDomain`)
- Native macOS monitor (`MonitorDomain`) — same JSON event schema as browser monitor
- Credentials: LocalAuthentication prompt (`AuthDomain`), the secret-registration box + data-protection keychain (`SecretsDomain`), and the administrator-prompt filler (`AuthDialogDomain`) — see *Secret vault* below

Communication: CLI / daemon → Unix socket (`/tmp/interceptor-bridge.sock`) → bridge router → domain handler → CGEvent / AX / etc. Daemon→bridge frames go through the shared backpressure queue (`daemon/socket-write.ts`, issue #229) — the bridge's length-prefixed reader waits indefinitely for a truncated frame's tail, so an unchecked oversized write used to hang that request and eat every one behind it.

#### Dispatch invariant — read `action["sub"]`, not `command`

The Router collapses an action `type` like `macos_nlp` into `command="nlp"` for two-segment types (see `Router.swift:43-55`). The CLI parser puts the actual verb in `action["sub"]`. **Every domain handler MUST read `let sub = action["sub"] as? String ?? command` and switch on `sub`.** Switching on `command` directly is a bug — every verb falls through to `default → notImplemented` even when handlers exist. Keep this invariant when adding new domains.

For screenshot saving, `interceptor-bridge/Sources/Domains/CaptureDomain.swift` no longer relies on `FileManager.default.currentDirectoryPath` when running under `launchd`. The CLI passes its working directory (`cli/commands/macos.ts`), and the bridge falls back through Downloads, home, then temp so `interceptor macos screenshot --save` works cleanly under LaunchAgent execution.

#### Accessibility trust gate and signing-aware `trust`

The router fails AX-dependent verbs loud when the bridge is not a trusted accessibility client (issue #163). Without the TCC grant, every AX C call returns `kAXErrorAPIDisabled` and the handlers used to degrade into empty *success* — `tree` printed nothing and exited 0, `find`/`windows` returned `[]` — which read as "this app has no accessible elements" instead of "the permission is missing". `Router.route()` now checks `AXIsProcessTrusted()` before dispatching any of the 16 AX-gated verbs (`tree`, `find`, `inspect`, `value`, `action`, `focused`, `windows`, `resize`, `move`, `click`, `type`, `keys`, `scroll`, `drag`, `menu`, `text`) and returns a typed error (`code: "accessibility_unusable"`, `remediation: "interceptor macos trust --walkthrough"`) that the CLI prints with a `fix:` line and a non-zero exit. Compound verbs (`open`/`read`/`act`/`inspect`) re-enter the router and propagate the same error instead of composing a success around an empty tree. `frontmost`/`apps` (NSWorkspace), `screenshot` (Screen Recording is a separate TCC service), `display`, and `monitor` (which has its own preflight) are deliberately not gated.

Compound `open` addresses a freshly-launched app by pid: `NSWorkspace.openApplication`'s completion can fire before the app registers in `NSWorkspace.runningApplications`, so the immediate by-name AX lookup used to miss (and, pre-gate, was masked as success with an empty tree). `AppLauncher.launch` hands the launched app's pid back to `handleOpen`, which addresses the tree/windows reads with it; an explicit caller-supplied pid always wins.

`interceptor macos trust` additionally reports how the running bridge binary is signed (`signing: {adhoc, teamId, identifier, cdhash}` via `SecCodeCopySigningInformation`). This matters after rebuilds: **TCC pins a grant to the binary's code identity.** The Developer ID-signed pkg has a stable identity, so grants survive updates; an ad-hoc dev build (what `scripts/build-bridge.sh` produces without a signing identity in the keychain) has no identity, so the grant pins to the build-unique cdhash and silently stops applying on the next rebuild — while the System Settings row still shows the toggle on. When the binary is ad-hoc signed, `trust` emits a warning and the gate error explains the fix: remove the stale `interceptor-bridge` row (−) in System Settings → Privacy & Security → Accessibility, re-grant, or install the signed build.

#### AX transport seam, typed codec, and traversal budget

Every Accessibility C call in the bridge routes through one injectable seam, `AXTransport` ([`interceptor-bridge/Sources/AXTransport.swift`](interceptor-bridge/Sources/AXTransport.swift)). `LiveAXTransport` is the only production implementation that imports `ApplicationServices`; a fake implementation drives the same surface in unit tests, so messaging timeouts, malformed values, and per-slot errors are testable without a live app. Nine domains route through it (`AccessibilityDomain`, `TextDomain`, `MenuDomain`, `InputDomain`, `MonitorAxBridge`, `MonitorInputBridge`, `MonitorDomain`, `DisplayDomain`, `TrustDomain`) — no domain calls an AX C function directly.

**Self-targeted mutations run on the main thread (issue #222).** When the element an AX mutation targets belongs to the bridge's own pid, HIServices does not hop through IPC: it calls the bridge's own AppKit accessibility entry points synchronously on the calling thread, and that thread is one of the `Transport` worker queues every request is dispatched on. Pressing the bridge's Sparkle alert therefore used to close an `NSWindow` off the main thread and trap AppKit (`EXC_BREAKPOINT`, "Must only be used from the main thread"). `LiveAXTransport.performAction` and `setAttributeValue` now check `AXUIElementGetPid(element) == getpid()` and, when true and not already on main, run the C call via `DispatchQueue.main.sync` (`AXSelfTargetPolicy` is the pure rule). Foreign pids keep the plain cross-process call, and the seam placement means all nine mutate call sites across `InputDomain`, `AccessibilityDomain`, and `MenuDomain` are covered at once. Self-targeting needs no Accessibility grant, so the trust gate is irrelevant to this path.

Values decode through one non-trapping typed codec, `AXValueCodec`, which checks the CF type ID, then `AXValueGetType`, then the typed extraction result before touching a value. Failed extraction becomes a typed `decode_failed` instead of a trap, and the previous force casts (`as! AXValue`, `as! AXUIElement`, `unsafeBitCast`) are removed. Output is acyclic and JSON-safe: elements become ref tokens (never nested handles), integers outside the JS safe-integer range become decimal strings, and non-finite numbers never leak into JSON.

Secure classification is centralized in `AXSecureRedaction`: a value from an `AXSecureTextField` is redacted to a fixed placeholder before serialization, logging, and error construction, and no flag can override it.

`tree` and `find` walk under a per-command budget (`AXBudget`): a wall-clock deadline plus node and AX-call caps, checked cooperatively between calls, with a per-element messaging timeout as the in-flight bound for a single synchronous call. A large or slow tree returns a bounded partial ending in a `… (stopped: <reason>)` marker instead of running to the CLI timeout; callers tune it with `--max-nodes` / `--max-ms`, and the bridge clamps to safety hard caps.

#### One supervised bridge instance, honest disconnects (issue #222)

The bridge is owned by its LaunchAgent (`KeepAlive.SuccessfulExit = false`: a crash is respawned, a clean exit is not). Three rules keep it to exactly one instance across installs, updates, and crashes:

- **Only supervised starters.** The daemon's bridge-recovery ladder ([`daemon/bridge-recovery.ts`](daemon/bridge-recovery.ts)) used to escalate from `launchctl kickstart -k` to `open -gj <bundle>` after 1.5 s, but launchd throttles respawns for about 10 s, so the escalation routinely launched a second, unsupervised bridge that survived the next install. With a LaunchAgent on disk the ladder now emits only supervised actions: `launchctl bootstrap` when the agent is not loaded, then a plain `kickstart` (no `-k`, which would kill a start already in flight); the `open`/bare-binary actions remain for source checkouts without a LaunchAgent. `SparkleUpdaterDelegate.updaterShouldRelaunchApplication` returns `false` because the pkg postinstall is the restart owner, and that postinstall stops every running `interceptor-bridge` for the installing user before it bootstraps, not just the pid in the pid file.
- **Ownership-aware cleanup.** Every instance writes `/tmp/interceptor-bridge.pid` before `Transport` unlinks and rebinds `/tmp/interceptor-bridge.sock`, so the pid file always names the current owner of both. `Platform.cleanup()` unlinks them only when the pid file names the exiting process; an older instance that exits later leaves the live bridge's files alone.
- **Fail-fast on disconnect.** When the bridge socket closes, the daemon immediately resolves every in-flight bridge request with `bridge disconnected while handling '<type>' …` (pointing at `interceptor status` and the crash-report location) instead of letting the CLI sit out its 15 s timeout and print the TCC-prompt hint. The same resolver path covers CLI requests and runtime-agent delegations.

#### Live frontmost resolution (issues #168, #198)

The bridge never trusts `NSWorkspace.frontmostApplication` as a primary source; the only reads are the resolver's own last-resort stage and the guest agent's inline copy of it. That property — and every time-varying `NSRunningApplication` property, `isActive` included — is a push-updated cache that AppKit refreshes only on turns of the process's main run loop; in the headless bridge (main thread parked in `NSApp.run()`, handlers on background queues) the cache freezes and kept reporting one app across dozens of real activations (issue #168: 27/36 divergences vs System Events truth). Every frontmost consumer therefore **pulls** the answer live through [`interceptor-bridge/Sources/FrontmostResolver.swift`](interceptor-bridge/Sources/FrontmostResolver.swift), a four-stage ladder: (1) the system-wide AX element's `kAXFocusedApplicationAttribute` → pid; (2) on failure — which is exactly the windowless-frontmost case of issue #198, since that attribute follows *window* focus — a per-app `kAXFrontmostAttribute` scan over `.regular` running apps (the System Events algorithm; a windowless frontmost app owns zero on-screen windows at any layer, even its menu bar belongs to Window Server, so no window scan can resolve it), with a 0.25 s per-candidate messaging timeout so one wedged app can't stall the ladder; (3) the first layer-0 window of `CGWindowListCopyWindowInfo(.optionOnScreenOnly)`'s front-to-back order (live WindowServer data, needs no AX trust — this is why `frontmost` stays off the AX gate list); (4) the cached scalar as a last resort. Stages 1–2 go through the `AXTransport` seam so the ladder is unit-testable with the fake. The `frontmost` payload reports which stage answered (`"source": "ax" | "axScan" | "windowList" | "cached"`) so callers can tell a focus-derived answer from a degraded one. A fresh `NSRunningApplication(processIdentifier:)` is constructed from the resolved pid so name/bundleId are never read off a frozen instance. All frontmost-defaulting surfaces route through the resolver — `frontmost`/`app` verbs, no-`--app` targeting in `tree`/`read`/`menu`, vision/screenshot window fallback, `monitor --frontmost` attach, and per-event app attribution in the monitor input/tap bridges — and `AppsDomain.activationReachedTarget` is live-pid equality only (its old `isActive` conjunct read the same frozen cache and could veto real activations forever). The in-guest agent (`InterceptorD/main.swift`, a separate SwiftPM target) carries a minimal inline copy of the same ladder.

#### Speech utterance finals (`monitor --include speech`, issue #218)

Buffer-based `SFSpeechRecognizer` recognition never finalizes per utterance — Apple's contract is that an audio-buffer request does not finish until `finish()` / `endAudio()` is called — so `isFinal` arrived only at the bridge's own ~55 s task restarts, and on-device those finals carry empty text (the report: 232 partials, 2 empty finals, 0 transcript segments, blueprint gate unreachable). `MonitorDomain` therefore synthesizes utterance-final `speech_segment` events from the latest partial. Partials update pending state (emitted at most once per second for live tailing); a boundary signal flushes the pending text as `isFinal: true`. Recognition metadata (delivered on utterance-complete results) starts a 1.2 s grace window so a trailing revision still lands in the final, and a partial inside that window that does not carry the pending stem forward (anything but a tail revision — `SpeechUtteranceSegmenter.isRevision`, a pure rule pinned by its own test) flushes the old utterance immediately so the next one never overwrites it; ~3 s of silence, the task restart, and stop flush unconditionally — *before* `finish()`, because the pending partial is the utterance's only copy. Empty flushes are dropped; a repeated phrase is a real utterance and is kept. On the CLI side, `interceptor monitor task quality|snapshot|diagnose` resolve the task's name as well as its generated id (`resolveMonitorTaskId` in `shared/monitor-tasks.ts`), `quality` synthesizes a missing transcript before grading, and `macos monitor stop --sid` names the owning task and the two commands that complete the epilogue `stop --task` would have run.

#### Secret vault and credential delivery (issue #244)

Credentials are stored once and delivered **by name**; no surface ever carries a value on argv. `daemon/secrets.ts` (pure, unit-tested) owns the rules: names, gates (`none` | `touchid` | `biometry`), target allowlists (`sudo`, `macos:<bundleId>`, `browser:<host>` with subdomain match, `ios`, `any`), memory-only unlock windows, and `resolveSecret()` — metadata → target check → gate → keychain read, in that order, so a wrong target never even prompts. Two vault backends sit behind one interface: `Bun.secrets` in the login keychain, and the bridge's `SecretsDomain`, which uses `SecItem*` with `kSecUseDataProtectionKeychain` so items belong to the signed bridge's access group and no ACL dialog can ever appear. `scripts/build-bridge.sh` embeds the Developer ID provisioning profile and adds `application-identifier`, `team-identifier`, and `keychain-access-groups` only on the Developer ID signing path and only when the profile's App ID matches the signing team, so white-label and ad-hoc dev builds keep launching (they report `dataProtection: false` and the daemon uses the login keychain). The daemon's `LayeredVault` writes to the bridge, reads bridge-then-login (so items stored before the entitlement kept working), and deletes both.

Delivery is daemon-side. Every `--secret` action reaches `deliverWithSecret()` in `daemon/index.ts` **after** the request log line, which `daemon/redact.ts` reduces to the secret's name (`actionLogSummary`; the same rule covers the vault verbs, `ios_login`, and every outbound frame via `outboundLogSummary`). The daemon derives the real target — the frontmost or `--app` bundle id for `macos type`, the tab's URL host (probed with the caller's group scope) for browser `type`, `com.apple.SecurityAgent` for `authdialog`, `sudo`, or `ios` — resolves, emits a `secret_release` event (`released` | `denied`), and hands the value to one leg: `macos_type` / `macos_authdialog` to the bridge; `input_text` / `find_and_type` to the extension with `sensitive: true` (the content script marks the element so the monitor records `***SECURE***` regardless of input type); `os_type` keeps the text in the pending-request entry and posts it from the daemon, so the extension only focuses the field; `ios_type` / `ios_keys` / `ios_unlock` to the runner; `macos_sudo` to `runSudo()`, which spawns `sudo -S -k -p "" -- <cmd>` and writes the value to stdin (`--keep` drops `-k` so a burst rides sudo's own cache). The gate is `AuthDomain`'s `LAContext` (`deviceOwnerAuthentication`, so Touch ID, Apple Watch, or the Mac password), with the reason naming the secret, the target, and the requesting session; `macos secret unlock --for` opens a window that skips the prompt, and `reveal` is always gated, TTY-only, and refused under `--json` or MCP (`INTERCEPTOR_MCP=1`).

**Browser saved logins (issue #248).** When the credential already lives in a Chromium browser's own password manager rather than the vault, `type --browser-login <host> [--user] [--browser <key>]` fills it. The browser suppresses its autofill dropdown for a synthetic/CDP click, so the value is read at rest instead of triggered in the UI. `daemon/browser-creds.ts` carries a `CHROMIUM_BROWSERS` descriptor table (Chrome, Brave, Vivaldi, Edge, Chromium, Arc); `detectInstalledBrowsers()` scans disk for a `Login Data` store so nothing is hardcoded as "the" browser. For the resolved browser it fetches the `<Brand> Safe Storage` key from the login keychain (`security find-generic-password`), derives the AES key (PBKDF2-HMAC-SHA1, salt `saltysalt`, 1003 iterations, 16 bytes), copies the profile's `Login Data` SQLite (the browser holds the original open) and decrypts the `password_value` blob (macOS `v10`, AES-128-CBC, IV of sixteen `0x20` bytes) — the macOS scheme is identical across all Chromium browsers. The reader depends only on columns stable across versions (`origin_url`, `username_value`, `password_value`); an unrecognized cipher prefix such as the app-bound `v20` is refused, not mis-decrypted. Delivery goes through `deliverWithBrowserLogin()`, which shares `deliverResolvedValue()` with `deliverWithSecret()` — same `input_text` / `find_and_type` / `os_type` legs, same `sensitive: true` redaction, same `***SECURE***` marking. The allowlist is implicit and strict: the requested host must match the live tab host (`targetForAction`), and the resolved credential's own origin host must match too, so a page can only fill its own saved login. A `browser_login` event records `released` | `denied` with the host, field, and browser (never the value). Enumeration (`browser creds list|status`, `handleBrowserCredsAction`) returns host + username + browser only and is refused when `INTERCEPTOR_MCP=1`, enforced in the CLI parser (`cli/commands/browser.ts`) where the marker lives. macOS only; reading `Login Data` needs the daemon to have Full Disk Access.

`AuthDialogDomain` handles the macOS administrator prompt, which has two shapes: Apple's own GUI flows show a Touch ID sheet with a "Use Password…" button, third-party and CLI callers get the user-name + password form. `fill` scans `com.apple.SecurityAgent` through AX, presses "Use Password" when there is no secure field yet, corrects the user-name field to the current user, focuses the secure field, delivers the value as unicode keystrokes (`InputDomain.postUnicodeKeystrokes`, the same path `type` uses; secure fields refuse AX value-set), and with `--submit` presses the confirm button (or Return) and reports whether the dialog closed. The `authdialog` prefix is on the router's AX-gated list. Registration (`SecretsDomain.register`) is an AppKit panel with two `NSSecureTextField`s, a gate popup, and a targets field; a focused secure field turns on Secure Event Input, so no event tap sees the keystrokes, and the value returns to the daemon over the local socket only.

### CDP app control — Electron / Chromium desktop apps

A third control surface (after browser and macOS bridge): drive the *web content
inside* Electron/Chromium apps (Slack, VS Code, Descript, …). Lives in
[`daemon/cdp/`](daemon/cdp/) + [`cli/commands/cdp.ts`](cli/commands/cdp.ts) +
[`shared/cdp-app.ts`](shared/cdp-app.ts); no Swift bridge required.

- **Path A (`interceptor cdp`)** — the daemon opens an **outbound** CDP WebSocket
  (`daemon/cdp/connection.ts`) to a target's `webSocketDebuggerUrl` (discovered via
  `daemon/cdp/discovery.ts`), registers it as a `cdp:<app>` context in a third
  connection class (`cdpManager`, parallel to `extensionWsMap` and the bridge
  socket), and translates verbs to CDP (`daemon/cdp/translate.ts`:
  `eval`→`Runtime.evaluate`, `screenshot`→`Page.captureScreenshot`,
  `click`→`Input.dispatch*`, `net`→`Network`/`Fetch`). Needs a relaunch with
  `--remote-debugging-port` (gated by **no fuse** → works on every app incl.
  hardened Slack/Claude).
- **Path 0 (`interceptor app`)** — `SIGUSR1` activates the app's *own* Node
  inspector at runtime (no restart; `daemon/cdp/inspector.ts`), then
  `session.loadExtension` loads a resident extension that registers as an
  `app:<name>` extension context. Gated by the `nodeCliInspect` fuse (Electron
  default ON). Falls back to Path A when the fuse is off.

Routing: a `cdp:`-prefixed `contextId` (or a `cdp_*`/`app_*` action) is routed to
`cdpManager` in both the socket and WebSocket daemon handlers; `app:` contexts are
ordinary extension contexts. `interceptor contexts` lists both alongside browser
contexts. See `.agents/skills/interceptor-macos/references/cdp-app.md`.

Why CDP here despite the browser surface's zero-CDP rule: that rule defends the
user's *real browser* against anti-bot fingerprinting. These are the user's *own*
apps — no adversary — so CDP is the correct primitive, not an escalation.

### iOS device surface — on-device InterceptorRunner (`ios:<udid>`)

The fifth surface: drive *any installed app* on an owned,
unlocked, Developer-Mode iPhone via **our own in-tree XCUITest runner**,
[`ios/InterceptorRunner/`](ios/InterceptorRunner/) — **not** WebDriverAgent. Host
side lives in [`daemon/ios/`](daemon/ios/) + [`cli/commands/ios.ts`](cli/commands/ios.ts)
+ [`shared/ios-device.ts`](shared/ios-device.ts).

**Topology mirrors the browser extension and the in-process `runtime:` agent, not
the CDP app channel: the device dials IN.** The on-device InterceptorRunner opens
a WebSocket to this daemon and registers `{type:"ios", udid, token}` (parallel to
the extension's `{type:"extension"}`). `IosManager` (`daemon/ios/manager.ts`,
parallel to `cdpManager`) validates the per-session `token` — injected into the
runner at launch and never reused — binds the socket to a `RunnerChannel`
(`daemon/ios/channel.ts`), and drives the runner over that socket with `{id,
action}` → `{id, result}` frames. Registration is keyed by udid slug
(case-insensitive) so a runner reporting either the raw devicectl UDID or a
lower-cased context slug resolves to the same pending `enable`. Concurrent verbs
on a not-yet-connected device share one in-flight launch (dedup by `contextId`),
so they can't double-launch and orphan a runner.

Two launch paths, selected by `preferNoXcodeIosPath()`:

- **No-Xcode.** Everything is done in pure Bun with no Xcode,
  no root helper, and the *end user's own* Apple ID. `daemon/ios/lockdown.ts`
  speaks the lockdown/pairing protocol over macOS's own `usbmuxd`;
  `daemon/ios/signer.ts` re-signs the bundled unsigned runner with the user's
  cert/profile (`keychain.ts`); `daemon/ios/installer.ts` installs it over AFC;
  `daemon/ios/usertunnel.ts` stands up the userspace CoreDeviceProxy tunnel + RSD
  + DDI lookup and completes the `testmanagerd` DTX handshake
  (`daemon/ios/testmanagerd.ts`) to launch the runner. `ddi.ts` mounts the
  developer disk image. Certs/profiles are created at `interceptor ios setup`;
  a 6-hour background timer re-signs before free-tier expiry (`state.ts`).
- **Xcode (operator machines).** `xcodebuild test-without-building` against the
  bundled `.xctestrun` installs + launches the runner and Xcode owns the iOS 17+
  tunnel + DDI.

Either way the runner then dials back into the daemon WS. A legacy `--wda-url`
HTTP path (`daemon/ios/wda-client.ts`, `usbmux-forward.ts` port-forward — pure
Bun, no `go-ios`/`pymobiledevice3`) remains only as a deprecated escape hatch.

The runner's element-tree snapshot is parsed into a ref-registered tree
(`daemon/ios/tree.ts`) mirroring the macOS AX output; **refs carry frames so
actuation is a deterministic coordinate tap** (robust against handle staleness).
Screenshots are VLM-budget resized via `sips -Z` (no new dependency). iOS
XCUITest AX ops are slow, so `ios_*` actions get an elevated request timeout
(`daemon/index.ts`, `cli/transport.ts`).

Routing: an `ios:`-prefixed `contextId` (or an `ios_*` lifecycle/verb action) is
routed to `iosManager` in both the socket and WebSocket daemon handlers, exactly
like `cdp:`; `validateContextRouting` gains an `iosContexts` param; `interceptor
contexts` lists `ios:<udid>` alongside the rest. Capability-blind: the shipped pkg
carries an **unsigned** runner and **no** signing material — signing is delegated
at runtime to the user's Apple ID (no-Xcode path) or the operator's Xcode config
(`scripts/audit-capability-blind.sh` check #4). See `docs/ios/app-route.md`.

**Beyond the runner — sibling lanes on the same `ios:<udid>` context.** These route
*before* the runner fallback (their action sets in `shared/ios-dev.ts` /
`shared/ios-service.ts` / `shared/ios-web.ts` are tested first), so they never wake
the XCUITest runner and work even while it's idle. All are pure-Bun and add no
runtime dependencies; NSKeyedArchiver replies decode through `daemon/ios/nskeyed.ts`.

- **Instruments / DTX + telemetry** (`daemon/ios/instruments.ts`, `dev-manager.ts`,
  `tunnel-pool.ts`): a direct `com.apple.instruments.dtservicehub` RSD service over
  the shared tunnel — live process list, per-process CPU (sysmontap), launch/kill
  (processcontrol), GPS simulation, GPU sampling, and a runner-free screenshot.
  `interceptor ios proc / top / spawn / kill / location / gpu / shot / backup / axtree`.
- **On-device JS brain** (`ios eval`): pushes a JS program into the runner's
  `JSContext` with an `Interceptor` global (`tree / tap / type / sleep / log /
  foreground`), so an observe→decide→act loop runs on the device in one round-trip.
- **Classic-Lockdown device services** (`daemon/ios/service-*.ts`): diagnostics,
  syslog, AFC files, crash reports, profiles, Darwin notifications, SpringBoard —
  `interceptor ios logs / diag / fs / crash / profiles / notify / springboard`.
- **WebKit inspection** (`daemon/ios/webinspector-*.ts`, `web-manager.ts`): the
  WebInspector protocol over RemoteXPC to read/drive Safari & WKWebView content —
  `interceptor ios web *`.

**Passcodes and the lock screen (issue #244).** `ios type` / `ios keys` accept `--secret <name>`; the runner's `keys` op types into the foreground app and, when that app has no keyboard focus (a Face ID fallback sheet or Settings passcode sheet belongs to SpringBoard), retries against `com.apple.springboard`, or takes an explicit `bundleId`. The `unlock` op wakes the phone (`press(.home)`), swipes up to the passcode pad, waits for SpringBoard's `secureTextFields["Passcode field"]`, types, and waits for the `com.apple.springboard.lockstate` Darwin notification to read 0 (`ICIsScreenLocked` in `ObjCSupport.m`); `--probe` stops before typing and reports lock state and whether the field appeared. It only works while the runner is resident — XCTest cannot start on a locked phone, so the first unlock after a reboot is manual. `ios press lock` posts the Power key through XCTest's private `XCDeviceEvent` (HID page `0x0C`, usage `0x30`, 0.5 s) because `pressLockButton` no longer locks on iOS 27, and falls back to the old selector when the private API is absent.

**Dial-back address: the runner has to reach the Mac.** `daemon/ios/ws-host.ts` replaces the old first-non-internal-IPv4 pick. `resolveRunnerDialBack` walks a ladder: `INTERCEPTOR_WS_URL` override → loopback for simulators → a CGNAT (`100.64.0.0/10`) address on a `utun` interface (a Tailscale-style VPN) → the Mac interface whose kernel index equals the phone's usbmuxd `InterfaceIndex` (`parseUsbmuxNetworkAddress` decodes the Darwin `sockaddr` blob, AF_INET at bytes 4-7 and AF_INET6 at bytes 8-23; `os.networkInterfaces()` exposes the index as `scopeid` on each interface's link-local IPv6 entry) → an IPv4 subnet match → the default-route interface → the first non-internal IPv4. `interceptor ios status` reports the choice as `dialBack` / `dialBackVia`, and a registration timeout names the address, the rung, and the fix. VPN comes first because iOS Local Network privacy silently denies a backgrounded app's local-network connection while its privilege is undetermined (XCTest backgrounds the runner before it dials); a VPN address is exempt, and once the user grants InterceptorRunner in Settings › Privacy & Security › Local Network, LAN dial-back registers in about ten seconds. `ios unlock` and `ios unlock --probe` require an already connected resident runner and fail fast instead of trying to launch XCTest on a locked phone; `ios press` returns the observed lock state.

### Native Agent — CDP-depth inside native apps

The fourth surface. Where the macOS bridge sees the *outside* of a native app
(AX tree, OS input, window pixels), the Native Agent runs an Interceptor dylib
*inside* the target and drives it against the host's own ObjC/Swift runtime —
read the live view/object graph, run selectors, **rewrite rendered text**,
intercept/redirect — with no Frida and no SIP-off.

The agent (`interceptor-agent/`, a `.dynamic` SwiftPM lib) gets in via the
lightest viable vector the **shipped core** supports directly — an own-build link
(rung-1) or `DYLD_INSERT_LIBRARIES` for weak-entitlement apps (rung-3). The
**hardened-target managed-copy re-sign** path (rung-4) was relocated out of the
shipped product into an operator-supplied extension (see the *Extension
Fabric* section below); `NativeDomain.enable` now performs rung-1/rung-3 only and otherwise
returns a neutral delegation/guidance response ("hardened-target managed-copy audit
handler not installed", or "system platform target requires a research build").
On load a C constructor calls `bootstrap()`, which connects to the
daemon WebSocket and registers as `native:<app>` — so it reuses the extension
verb-routing, `contexts`, and disambiguation paths. TCC-gated work is delegated
back to the bridge (which already holds the grants) via `{type:"delegate"}`
frames, so a re-signed copy's reset TCC doesn't bite the control plane. The
tiered **hook fabric** (ObjC swizzle / `dyld` interpose) + runtime-style
domain/event protocol rides on the same agent. Driven with `interceptor macos
runtime <verb> --context runtime:<app>`. Bridge handler: `NativeDomain.swift`
(`macos_native_*`). Full reference: `docs/native/agent.md`.

### Extension Fabric — capability-blind, operator-supplied extensions

The shipped product is a **capability-blind host**: it carries the extension
*loader* and *neutral interfaces* only — it knows how to *discover* an extension
and surface its domains/verbs/agent/skill, but nothing about what any extension
*does*. Operators drop a self-contained bundle into a standard path; on next start
the bridge registers its domains, the CLI surfaces its verbs, the agent loader
finds its dylib, and `interceptor extensions sync` links its skill. Absent any
extension the product is exactly the owned-app audit tool above.

Discovery root: `~/.interceptor/extensions/<name>/` (override
`INTERCEPTOR_EXTENSIONS_DIR`); **filesystem-only, no network fetch**. A neutral
`manifest.json` declares *what surface* the extension adds, never *how*:

```
<name>/ manifest.json  bridge/<handler>.dylib  agent/InterceptorAgent-<slice>.dylib  cli/  skill/SKILL.md
```

Four load points, each generalizing an existing primitive:

| Surface | Mechanism |
|---|---|
| **Bridge domains** | At startup (after every built-in `router.register`), `ExtensionFabric.loadAll` scans manifests, verifies each `bridge/*.dylib` in software (`SecStaticCodeCheckValidity` + `kSecCSCheckAllArchitectures` + an optional operator Team-ID allowlist — because the bridge has `disable-library-validation`, so the OS check is re-imposed in software), `dlopen`s it, and adapts a **serialized C ABI** (`uint32_t itc_ext_abi_version`, `char* itc_ext_handle(commandJSON, actionJSON)`) to a Swift `DomainHandler` via `ExtensionDomainAdapter`, then `router.register(prefix, adapter)`. `Router.isRegistered` reserves built-in prefixes (no clobber); prefixes are a single `^[a-z][a-z0-9]*$` token. Failures are isolated + logged, never fatal. |
| **CLI verbs** | `parseMacosCommand` (`cli/commands/macos.ts`) is fed the manifest-declared prefix set by a synchronous discovery scan, so `macos <prefix> <cmd>` falls through to a generic builder emitting `{type:"macos_<prefix>_<cmd>"}` (hyphens→underscores, mirroring `vm`) instead of the hard `default`. The daemon already forwards any `macos_*` to the bridge. |
| **Agent dylib** | `resolveAgentDylib` (`NativeDomain.swift`) searches per-extension `~/.interceptor/extensions/*/agent/` ahead of the legacy paths. |
| **Skill** | `interceptor extensions sync` symlinks `<name>/skill/` into the host agent skill dirs (`~/.claude/skills`, `~/.agents/skills`, `~/.openclaw/skills`, `~/.config/opencode/skills`) as `interceptor-ext-<name>/`. Shipped skills carry only a neutral one-line pointer. |

Files: shared `shared/extensions.ts` (types + discovery), bridge
`interceptor-bridge/Sources/ExtensionFabric.swift` (loader + C-ABI adapter +
signature gate) called from `main.swift`, CLI `cli/commands/extensions.ts`
(`list` / `sync`). Author guide: `docs/extensions/{authoring,bridge-abi}.md`.

**Capability-blind boundary (enforced).** The most sensitive flow — the
hardened-target managed-copy audit (BYO re-sign + entitlement-continuity replay +
launch-exception handling) — is the **first reference extension**,
`native-managed-copy`: operator-possessed, out-of-repo, never in the `.pkg` and
never in the commit tree. `scripts/audit-capability-blind.sh` (wired into
`.github/workflows/ci.yml` and `test/extension-fabric.test.ts`) asserts the
tracked tree carries zero relocated managed-copy specifics, that shipped skills
carry only a neutral extension pointer, and that the core never network-fetches an
extension. `release.sh` (Step 6.5) asserts the `.pkg` ships no extension bundle.

---

## MCP Control Plane

`interceptor mcp serve` exposes the entire CLI surface over the Model Context Protocol (stdio) as a thin adapter over the same binary — it re-implements no verb. Every tool call shells back out to `interceptor <verb>` via `Bun.spawn` (`cli/mcp/adapter.ts`), inheriting arg parsing, compound fan-out, per-session `--group` isolation, daemon auto-spawn, and result formatting. The server ships inside the `interceptor` binary (no separate sidecar); `interceptor mcp` is dispatched from `cli/index.ts`.

- **Tools (`cli/mcp/server.ts`):** six routers — `interceptor_browser/macos/ios/read/local/raw` — whose verb menus are generated from the binary's own manifest (`COMMAND_SPECS`) plus maintained macOS/iOS lists. Sub-verbs and flags ride in a raw `args` array; the long tail is discoverable through `interceptor://manifest`, `interceptor://help/{macos,ios,verb}`, and `interceptor://extensions` resources.
- **Safety (`cli/mcp/tiers.ts`):** a (surface, verb, sub-verb) → tier classifier (read / mutate / destructive / arbitrary-exec) with fail-safe family floors — an unknown `vm`/`runtime`/`app` sub-verb defaults to its highest tier. The `INTERCEPTOR_MCP_ALLOW` operator allowlist is the only boundary: read+mutate run by default, destructive+exec fail closed until the operator opts in, and a model-set `confirm` is only a secondary speed-bump.
- **Inbound fencing (`cli/mcp/output.ts`):** content-bearing output (page text, trees, file/network reads) is wrapped as untrusted data before it reaches the client model. Output also maps to MCP text / `structuredContent` / image / resource-link blocks.
- **Install (`cli/mcp/install.ts`):** `interceptor mcp install` auto-detects and configures Claude Code, Codex, Gemini CLI, Cursor, and Claude Desktop with idempotent JSON / Codex-TOML merges, self-locating via `process.execPath`.

See `docs/mcp.md`.

## Build Outputs

| Artifact | Source | Purpose |
|---|---|---|
| `dist/interceptor` | `cli/index.ts` (Bun bundle + compile) | Standalone CLI binary |
| `daemon/interceptor-daemon` | `daemon/index.ts` (Bun bundle + compile) | Singleton daemon |
| `dist/interceptor-bridge` | `swift build -c release` | macOS native bridge |
| `extension/dist/background.js` | `extension/src/background.ts` (Bun bundle, target=browser) | MV3 service worker |
| `extension/dist/content.js` | `extension/src/content.ts` (Bun bundle, target=browser) | Content script |
| `extension/dist/inject-net.js` | `extension/src/inject-net.ts` (Bun bundle, target=browser) | MAIN-world net interceptor |
| `extension/dist/inject-canvas.js` | `extension/src/inject-canvas.ts` (Bun bundle, target=browser) | MAIN-world canvas observer |
| `extension/dist/offscreen.js` | `extension/src/offscreen.ts` (Bun bundle, target=browser) | Extension offscreen worker for OCR/image helpers |
| `extension/dist-safari/background-safari.js` | `extension/src/background-safari.ts` (Bun bundle, target=browser) | Safari MV3 native-relay service worker |
| `safari/build/Build/Products/Release/InterceptorSafari.app` | `scripts/build-safari.sh` + Xcode project | Safari containing app + embedded appex |

`bash scripts/build.sh` builds the Chromium, Electron, and Safari web bundles plus the CLI, daemon, and macOS bridge when Swift is available. `scripts/build-safari.sh` rebuilds those source bundles by default, runs a `WKWebExtension` background-bootstrap verifier, notarizes and staples the containing app, copies it to a guarded system-volume staging directory, requires Gatekeeper to accept that copy, and feeds those exact bytes to `pkgbuild` before notarizing/stapling the package. The Safari package postinstall moves only identifier-verified legacy `.InterceptorSafari-*.noindex` backup apps out of `/Applications` to recoverable Application Support storage, unregisters them, and registers the installed app; this prevents duplicate appexes with the same identifier. `INTERCEPTOR_SKIP_BASE_BUILD=1` is an advanced/CI escape hatch for an already-verified fresh bundle. Skip-notary builds are named `*-UNNOTARIZED.pkg` so they cannot be confused with installable release artifacts. On macOS older than 15.4 the engine-level verifier is skipped because the hosting API is unavailable. Windows builds skip native macOS artifacts.

The root `package.json` version is the release source of truth. `build.sh` copies it into the Chromium, Electron/MV2, and Safari WebExtension manifests; `release.sh` passes it into the Browser/Full package metadata and bridge bundle; the tag-driven Windows workflow uses the same version for both architectures; and `build-safari.sh` passes it to the containing app, appex, and separate Safari installer. The Browser and Full packages do **not** contain `InterceptorSafari.app`: a release that changes shared browser code must publish the separate `Interceptor-Safari-<version>.pkg` alongside them or explicitly declare Safari out of scope.

`scripts/build-store-zip.sh` packs the Chromium extension for the Chrome Web Store as `dist/Interceptor-Extension-<version>.zip` with the development `key` removed from the manifest (the store assigns its own id) and fails if any key remains. `build.sh` appends `-dirty` to the recorded commit when the tree has uncommitted changes, so `interceptor --version` on a local build says so.

Release builds also replace compiler-recorded checkout paths with the stable synthetic `/src/interceptor` namespace. `build-bridge.sh` limits the C `-ffile-prefix-map` to SwiftPM dependency checkouts, where BoringSSL records `__FILE__` strings; `release.sh` and `build-safari.sh` pass matching C and Swift prefix/compilation-directory maps to Xcode for the bundled iOS runner and Safari app. Before signing, the bridge and Safari builds strip local Mach-O symbols because their object-file records are outside compiler prefix-map coverage. The iOS payload contains only its runner app and `.xctestrun` descriptor, not compiler modules, symbols, or index data, and its tar ownership fields are normalized to `root:wheel`. The signed packages therefore contain useful source-relative diagnostics without disclosing the build machine's local filesystem or account name.

### Compiled stdout pipe integrity (patched MCP SDK + console.log routing)

Compiled Bun binaries have a runtime defect (observed through at least Bun 1.3.14): if any bundled module contains `import process from "node:process"` — even a module that never executes, e.g. behind a dynamic import on an untaken branch — the binary silently truncates **piped** stdout at 64 KiB on exit while file and tty output stay complete, and still exits 0 (issue #183). The only such modules in Interceptor's graph are the MCP SDK's stdio transports, bundled into every CLI binary via the dynamic `import("./commands/mcp")` in [`cli/index.ts`](cli/index.ts) even though they only load for `mcp serve` — so the truncation hit every verb whose output exceeded 64 KiB (`macos cdp raw`, large `text`/`html` reads, `--json` payloads), and it is exactly the pipe-consumer topology (agent wrappers) that broke, surfacing as JSON parse errors in the consumer. The fix is at the bundle level, not the write sites: `patches/@modelcontextprotocol%2Fsdk@1.29.0.patch` (applied by `package.json` `"patchedDependencies"` on every install) rewrites those imports to the `process` global, which does not trigger the defect. Per-write mitigations were measured and rejected: `await Bun.write(Bun.stdout, …)` deadlocks in an affected binary, and no after-the-fact flush recovers `console.log`'s buffered bytes. Bun keys patch files to the exact dependency version — bumping the SDK means regenerating the patch (`bun patch` → re-apply → `bun patch --commit`), never deleting it. [`test/compiled-stdout-pipe.test.ts`](test/compiled-stdout-pipe.test.ts) enforces both layers: the installed SDK files must be import-free, and a compiled fixture carrying a dead dynamic SDK import must deliver byte-complete output through a real shell pipe (the fixture must use the package specifier and a `/bin/sh` pipe — absolute-path imports and `Bun.spawn`'s own pipe do not reproduce the defect).

A second, independent Bun defect hits the **merged-stream** shape: when stderr and stdout share one pipe (`2>&1`) and a stderr write precedes a large stdout write — exactly the CLI's `[id] → <type>` transport trace line — `console.log` output past 64 KiB is lost on exit, interpreted or compiled, at any payload size. No after-the-fact flush rescues the buffer, but `process.stdout.write` does not exhibit the defect, so [`cli/index.ts`](cli/index.ts) overrides `console.log` at entry to route through `process.stdout.write(format(...))` — one block covering every output site in every command module, current and future; `console.error` stays native because stderr payloads never exceed the 64 KiB pipe buffer. The same test file guards both the override's presence and the merged-pipe delivery of a compiled fixture.

Relatedly on the daemon side, the WebSocket transport — the path `screenshot`/`save` are auto-routed to *because* native messaging drops large payloads — inherited Bun's default 16 MiB `maxPayloadLength`, and Bun answers an oversized message by **closing the connection**, killing every in-flight request on that socket (verified: 15 MiB accepted, 17 MiB → close 1006). [`daemon/index.ts`](daemon/index.ts) now pins `maxPayloadLength` to the same 64 MiB frame cap as the unix-socket transport (`MAX_UPLOAD_FRAME_BYTES`) and logs non-normal close codes so a future 1009-style kill is diagnosable from the daemon log; [`test/ws-max-payload.test.ts`](test/ws-max-payload.test.ts) guards the wiring and proves 17 MiB survives the shipped cap.

### macOS bridge action typing (photos export/thumbnail)

`cli/commands/macos.ts` forwards most flags into the bridge action as strings, but the Swift domains read typed fields — a field a domain casts with `as? Int` is **silently dropped** if the CLI forwards it as a string, because the cast fails and the handler falls through to its default path with no error. Photos `export --size` shipped in that state (#187): the resize+encode branch of [`PhotosDomain.swift`](interceptor-bridge/Sources/Domains/PhotosDomain.swift) was unreachable from the CLI, every export returned raw originals (HEIC on iPhone-sourced libraries), and `thumbnail --size` stayed pinned to its 256px default. The rule is: any flag whose Swift reader casts to a non-string type must go through `flagInt` (or an equivalently typed forward), never the generic string flag loop — [`test/macos-parser.test.ts`](test/macos-parser.test.ts) asserts the forwarded types for the photos flags, and `.agents/rules/macos-command-parser.md` binds parser, help, Swift handler, and test together. `export --format jpeg|png` composes with `--size` (#190): the resize branch encodes to the requested format and reports the true `uti`, and the no-size branch transcodes original bytes. Transcode paths do not rotate manually — `NSBitmapImageRep(data:)` applies EXIF/HEIF orientation at decode on supported macOS (verified empirically on sensor-native portrait HEIC), so encoded output is upright by construction.

### Windows installer and release lane

Windows payloads build per architecture — `--target=windows-x64` (Bun `x64-baseline`, no AVX2 requirement) and `--target=windows-arm64` — each staged under `dist/windows/<arch>/` with a static native-messaging manifest generated from `extension/store-identities.json` (production builds refuse unapproved store identities; `--development` allows the key-derived unpacked ID). `scripts/installer/interceptor.iss` produces a per-user, browser-only Inno Setup installer whose custom code is transactional: every PATH and native-host registry mutation is snapshotted to a registry journal before it happens, committed only after payload install succeeds, and compensated on failure, cancellation, or interrupted setup — foreign values, value types, and unrelated PATH tokens are preserved on both install and uninstall. During the replacement window Setup writes a current-user-ACL maintenance guard file that the CLI (`ensureDaemon`) and daemon check before spawn/bind, so a running browser cannot relaunch a half-replaced daemon. Upgrades stop the previous daemon through `interceptor daemon stop` — an authenticated local verb that presents the 256-bit token from the daemon's owner-only lock file over the local IPC transport, validates the acknowledgement against the locked process identity, and waits for both loopback ports to close; the WebSocket transport rejects shutdown outright. Uninstall removes only proven-owned state: journaled PATH tokens, native-host values it wrote (restoring priors), and skill links whose recorded target is inside the installed skill root (`skills unadopt --owned-root`). Production extension acquisition is store-only (Chrome Web Store / Edge Add-ons); the installer never edits browser profiles, never force-loads an unpacked extension, and never starts the daemon eagerly. `.github/workflows/windows-installer.yml` builds from exact `vX.Y.Z` tags only, against a pinned toolchain (`.bun-version`, `scripts/installer/windows-toolchain.lock.json`), signs payloads and installers, runs an install/repair/uninstall acceptance harness, attests, and uploads immutable release assets — `--clobber` is forbidden.

---

## Screenshot Pipeline

Two distinct capture paths share the `interceptor screenshot` surface:

### DOM render (default)

The default path renders the page's DOM directly to a canvas inside the target tab — no `chrome.tabs.captureVisibleTab`, no `chrome.tabCapture`, no browser focus or visibility requirement.

1. **Native render, nothing injected.** The renderer is part of the content script (`extension/src/content/dom-screenshot.ts`, bundled into `content.js`) and uses only browser primitives: it inlines computed styles into a DOM clone, embeds `<img>`/`<canvas>`/background-image resources as data URLs, serializes the clone into an `<svg><foreignObject>`, rasterizes that onto a canvas, and returns the data URL. Every step runs unthrottled on a hidden tab. An earlier design (through 0.18.2) loaded a vendored `html-to-image` bundle on demand as `screenshot-runner.js` via `chrome.scripting.executeScript`; that file was removed in 0.18.3 and no shipped extension contains it. A `Could not load file: 'screenshot-runner.js'` error therefore cannot come from a current build — it means the browser is still running an extension snapshot older than 0.18.3 (a running browser keeps its loaded service worker after a pkg install until `interceptor reload`). `interceptor diagnose` prints the version each connected extension registered with next to the CLI's and names the reload fix when they differ (issue #241).
2. **CORS clearance.** Before the render, the SW installs a `chrome.declarativeNetRequest` session rule (`extension/src/background/capabilities/screenshot-cors.ts`) scoped to `tabIds: [tabId]` and `resourceTypes: [image, font, media, stylesheet, xmlhttprequest]`. The rule sets `Access-Control-Allow-Origin: *`, removes `Access-Control-Allow-Credentials`, and sets `Cross-Origin-Resource-Policy: cross-origin` for the duration of the capture, then is removed in a `try/finally`. The rule lifecycle mirrors the CSP-bypass rule used by `evaluate.ts`.
3. **Render.** `dom-screenshot.ts` resolves the target node by mode (`full` → `document.documentElement`, `element` → refRegistry lookup, `selector` → `querySelector`, `region` → full + in-frame canvas crop) and rasterizes it as described in step 1. Any resource that cannot be fetched CORS-clean is replaced with a 1×1 transparent PNG so the canvas never taints and `toDataURL()` never throws; a `<canvas>` that is itself tainted falls back to a blank structural clone. A serialized SVG that the browser refuses to decode is the one genuine render failure — it is tagged `fallbackEligible` and drives the pixel auto-fallback below.
4. **Region crop in-frame.** For `--region`, the content script renders the full page once and then crops via a regular `<canvas>.drawImage` + `toDataURL` inside the same frame, so the inter-process message back to the SW carries only the cropped result instead of a multi-MB full-page payload.

### Pixel-true compositor capture (`--pixel`)

`--pixel` opts into the legacy `chrome.tabs.captureVisibleTab` path. It produces compositor-accurate output (hardware video frames, GPU filters, exact compositor pixels) but requires the browser window to be visible and focused. Single-viewport captures complete in ~50 ms when the window is focused.

`--pixel --full` scrolls the page and captures one viewport-sized strip per scroll position. Strip cadence is set above 1 second to clear Chrome's `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` quota (default 2/sec). Strips are stitched together inside the SW using `OffscreenCanvas` + `createImageBitmap` + `convertToBlob` — explicitly **not** routed through the offscreen-document `stitch` handler, because the IPC return path for multi-MB stitched results is unreliable.

**DOM-render → pixel auto-fallback.** On some heavy real pages the DOM renderer fails outright (the serialized foreignObject SVG won't decode). Rather than dead-end, the dispatcher retries a default whole-page capture via the pixel path. The gating and request shaping are pure logic (`planPixelFallback` in `capabilities/screenshot.ts`): only a genuine render failure is eligible (tagged `fallbackEligible` — not tab-not-found/restricted/timeout), only whole-page captures fall back (element/ref/region would crop against the wrong origin), the DOM path's PNG@92 defaults are preserved so nothing silently downgrades to the pixel path's JPEG@50, and the result carries a `fallback` note naming dropped options and the side effects (the pixel path borrows tab focus and scrolls; both restored). `no_fallback` (CLI `--no-fallback`) disables the retry. The CLI gives every screenshot a 175s transport ceiling — under the daemon's 180s request timeout — because the combined DOM-then-pixel path can legitimately outlive the old flat 45s.

### Transport routing

Screenshot responses can carry tens to hundreds of KB of base64 dataUrl. Empirical testing on Brave/Chromium showed the native-messaging port silently drops messages above ~50 KB despite the documented 1 MB cap, so the CLI auto-enables WebSocket transport for any `screenshot` invocation (`cli/index.ts`). `--no-ws` overrides if the user wants the native path.

---

## Implementation Notes

Recent major additions reflected in this document:

- capability-blind **extension fabric**: operator-supplied extensions add bridge domains / CLI verbs / agent dylibs / skills via a manifest + serialized C-ABI loader, with software-imposed library validation and a static capability-blind audit gate in CI; the hardened-target managed-copy audit flow relocated out of the shipped tree into the first reference extension
- **native runtime agent** + tiered **hook fabric**: in-process ObjC/Swift runtime control as a fourth surface (`runtime:<app>`)
- **CDP app control**: drive Electron/Chromium desktop app web contents (`cdp:`/`app:`) with no Swift bridge
- DOM-render screenshot pipeline as the default capture path; `--pixel` retains the legacy `captureVisibleTab` route as an opt-in
- per-tab CORS-clearance session DNR rule scoped to subresource fetches during a capture
- in-SW `OffscreenCanvas` stitching for `--pixel --full` so multi-MB responses no longer round-trip through the offscreen document
- automatic WebSocket routing for `screenshot` CLI invocations
- CLI-first Brave install path through `scripts/install.sh --brave --profile <profile>`
- frame-targeted `read --include-frames` with subtree refs preserved end-to-end
- canvas observer summaries that filter `log` and `objects` by DOM canvas index
- document-scoped monitor sessions with child-tab handoff and focus-follow
- transport hardening around disconnected native ports
- strict-CSP `eval --main` fallback via tab-scoped CSP stripping and retry
- launchd-safe macOS screenshot saving

---
