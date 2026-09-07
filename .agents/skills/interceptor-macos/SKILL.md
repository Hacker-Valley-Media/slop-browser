---
name: interceptor-macos
description: "Drive native macOS apps via interceptor macos *: AX trees, background click/type/keys/drag/scroll, occluded or minimized window capture, browser chrome, URL bars, OS dialogs, Apple Events, trusted OS input, monitor/replay, overlays, vision, speech, NLP, JSC host utilities, Electron app web-content control via interceptor macos cdp, and in-process app runtime control via interceptor macos runtime. Background-first by contract; only app activate and open --activate move focus. Use for native apps, named browser app routing, window control, cross-app work, and system UI. Not for content inside browser pages."
metadata:
  short-description: Drive native macOS apps via the interceptor CLI; background-first
---

<!--
Reserved namespace: `.agents/skills/interceptor-windows/` is reserved for a future
Windows surface (UIA, Win32 input, ETW). It does not exist yet — do not stub it.
-->

# Interceptor macOS

Agent-operator skill for the macOS surface of Interceptor. Use the `interceptor macos *` CLI to drive native macOS applications: AX trees, OS-level trusted input, capture / vision / speech / NLP / Apple Events, monitor-and-replay, overlays. Use `interceptor macos cdp` / `interceptor macos cdp app` for Electron app web contents, and `interceptor macos runtime` for in-process native app runtime control. For content inside a browser tab load `interceptor-browser` instead.

The macOS bridge is a Swift daemon launched as a LaunchAgent / `.app` bundle. It uses Apple frameworks including Accessibility, ScreenCaptureKit, AVFoundation, Speech and Vision. Some existing capture and runtime paths also use private CGS symbols or injected runtime access. Check the surface reference and actual capability result; public framework support does not guarantee every private path works on every OS release.

This installed skill is self-contained. Source checkouts also have `AGENTS.md`, but packaged users may only have the skill directory below `/Library/Application Support/Interceptor/skills`.

> Installed extensions may add capabilities under `interceptor macos <prefix> <cmd>`. Each carries its own skill (`interceptor-ext-<name>`); this skill does not describe them. Run `interceptor extensions list` to see what is installed.

## Fast Path

```bash
interceptor status                       # 1. Confirm daemon + bridge are alive
interceptor macos trust                  # 2. Confirm TCC permissions granted
interceptor macos open "Finder"          # 3. Tree + windows (background — does NOT raise Finder)
interceptor macos read                   # 4. AX tree + frontmost info
interceptor macos act e5                 # 5. AX press of ref e5 — no focus change
interceptor macos act e3 "hello"         # 6. AX value-set of ref e3 — no focus change
```

Treat `eN` refs as short-lived. AX state can change between calls; re-read before acting.

## The One Rule

**Only two commands move focus:** `interceptor macos app activate <app>` and `interceptor macos open <app> --activate`. Everything else is background-first by contract — `open` (without `--activate`), all input verbs, all reads, capture, AX, menu, intent dispatch, scroll, drag, vision, overlays. If you call any other command and the user's frontmost app changes, that is a bug — file it.

Full contract + verb inventory + worked examples + pitfalls: [`references/background-first.md`](references/background-first.md).

## Workflows

Each workflow is a complete self-contained "you are doing X" procedure. Open the file when the task matches.

| Workflow | When to invoke |
|---|---|
| [`workflows/capture-backgrounded-app.md`](workflows/capture-backgrounded-app.md) | Screenshot an occluded / minimized / cross-Space window — without activating it |
| [`workflows/drive-backgrounded-app.md`](workflows/drive-backgrounded-app.md) | Click / type / keys / drag against a non-frontmost app via AX + `postToPid` |
| [`workflows/dispatch-apple-event.md`](workflows/dispatch-apple-event.md) | Apple Events to a named bundle id — open URL in Brave, read active tab, etc. |
| [`workflows/read-ax-tree.md`](workflows/read-ax-tree.md) | `tree --app` of any app, with automatic Electron wake-up |
| [`workflows/record-and-replay-mac-flow.md`](workflows/record-and-replay-mac-flow.md) | `macos monitor` record + export + replay native UI flows |
| [`workflows/trusted-input-gate.md`](workflows/trusted-input-gate.md) | Satisfy an OS-level trusted-input gate that filters synthetic CGEvents |
| [`workflows/clear-human-verification-gate.md`](workflows/clear-human-verification-gate.md) | Clear a CAPTCHA / human-verification gate (reCAPTCHA, Turnstile, hCaptcha, generic) in the user's own signed-in session via cross-origin widget coordinate mapping + trusted `--os` click |

## References

| File | Topic |
|---|---|
| [`references/background-first.md`](references/background-first.md) | Full Background-First contract, verb inventory, reflexes-to-drop, pitfalls |
| [`references/accessibility-and-input.md`](references/accessibility-and-input.md) | AX tree mechanics, input routing, window control, credential delivery by name (`--secret`) |
| [`references/capture-and-vision.md`](references/capture-and-vision.md) | ScreenCaptureKit + CGS capture, Vision OCR, audio intelligence |
| [`references/advanced-domains.md`](references/advanced-domains.md) | Apple Events, container runtime, OS log, fs, URL fetch, file watch |
| [`references/jsc-host.md`](references/jsc-host.md) | Plain JavaScriptCore host capabilities, flags, scope rules, and pitfalls |
| [`references/monitor-and-replay.md`](references/monitor-and-replay.md) | Native monitor sessions, replay plans, event sources |
| [`references/command-catalog.md`](references/command-catalog.md) | Full macOS command surface with flags and examples |
| [`references/permissions.md`](references/permissions.md) | TCC permissions, microphone re-poll, Dock-icon notes |
| [`references/cdp-app.md`](references/cdp-app.md) | Electron/Chromium desktop apps via `interceptor macos cdp` / `interceptor macos cdp app` |
| [`references/native-agent.md`](references/native-agent.md) | In-process native app runtime control via `interceptor macos runtime` |

## When To Switch Surfaces

If the target is **inside a browser page** (DOM, network, SPA state, browser monitor, scene graph of a rich editor) - load `interceptor-browser` instead.

If the target is **inside an Electron/Chromium desktop app's web contents** (Slack, VS Code, Notion, Descript, etc.) - use [`references/cdp-app.md`](references/cdp-app.md), not AX screenshots.

If the target is **inside a native app's runtime** (AppKit/SwiftUI object graph, selector calls, rendered text changes, hooks, MapKit state) - use [`references/native-agent.md`](references/native-agent.md). AX is still the fallback projection when the in-process agent is unavailable.

## Do Not Default To Troubleshooting

- User wants a macOS task completed → run Interceptor commands.
- User wants Interceptor fixed, installed, or explained → that's a separate task; ask before diving into repo state.
- Inside the Interceptor repo, use this skill for live macOS validation, not as the primary source of repo-development instructions.
