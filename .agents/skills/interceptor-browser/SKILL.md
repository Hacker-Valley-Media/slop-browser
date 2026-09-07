---
name: interceptor-browser
description: "Drive a signed-in Chrome / Brave / Safari session via the interceptor CLI: open/read pages, click, type, inspect DOM/text/network, automate rich browser editors and scene graphs, capture WebSocket/Beacon/BroadcastChannel traffic, record/replay flows, take VLM-budgeted screenshots, compare pages, and route to specific browser contexts with --context. Use for browser page content, tabs, forms, SPA extraction, request overrides, page communication capture, and deployment checks. Not for native macOS apps, Electron desktop app web contents, OS dialogs, browser chrome, or large scraping."
metadata:
  short-description: Drive a real signed-in Chrome / Brave / Safari session via the interceptor CLI
---

# Interceptor Browser

Agent-operator skill for the Browser surface of Interceptor. Use the `interceptor` CLI (no prefix) to drive a live Chrome, Brave, or Safari session: pages, network, scene graph, monitor, screenshots. For native macOS apps load `interceptor-macos` instead.

This installed skill is self-contained. Source checkouts also have `AGENTS.md`, but packaged users may only have the skill directory below `/Library/Application Support/Interceptor/skills`.

## Core Rules

- Use compound commands (`open`, `websearch`, `read`, `act`, `inspect`) before low-level verbs.
- `websearch "<query>"` searches through the browser's configured default provider in an Interceptor-managed background tab and returns the provider page. It is not Google-specific. `find "<query>"` never navigates: it searches the current page's complete rendered-text snapshot plus accessible elements. Use `find --text-only` for passages and `find --elements-only`/`--role` for controls.
- Browser commands operate inside managed Interceptor tab groups. Do not use `--any-tab` unless the user explicitly authorizes acting outside those groups.
- Supported agent shells get a soft per-session group automatically, labeled `s-<hash16>`, so bare commands reuse one tab per session and the idle sweeper has a cleanup unit. `INTERCEPTOR_SESSION_ID` is the harness-neutral contract; Interceptor also detects verified Maestro, Claude Code, and Codex session variables. Soft scope falls back to the active managed tab when the session group is empty. `--shared-group` (or empty `INTERCEPTOR_GROUP=`) explicitly uses Interceptor's shared default group; it does not remove managed grouping. **Concurrent lanes often share one host session id**, so give each lane a unique `--group lane-<n>` or `INTERCEPTOR_SESSION_ID`. Explicit `--group <label>` and non-empty `INTERCEPTOR_GROUP` provide hard isolation by default: resolution stays within that group and cross-group targets are rejected unless `--any-tab` is explicitly authorized. `interceptor group list` shows the automatic label.
- Close your group with `interceptor group close <label>` when the job is done. The extension auto-closes groups after 10 minutes without tab activity by default; metadata polls such as `status` and `group list` do not keep a group alive. The timeout is configurable in the extension popup and is crash safety, not a substitute for cleanup.
- In a named group, including an automatic session group, `open` navigates the group's most-recent tab by default (address-bar semantics; the reused tab stays in the background unless you add `--activate`). Pass `--no-reuse` when you need to keep the current page and open another, for example before comparing two pages or fanning out. `tab new` creates by default; explicit `--reuse` navigates the group's most-recent tab. Shared-default `open` creates by default.
- `interceptor open <url>` and `interceptor tab new <url>` create background tabs by default. Only `open --activate`, `tab new --activate`, `tab switch <id>`, and `window focus <id>` intentionally move browser focus.
- If multiple browser profiles are connected, run `interceptor contexts` and pass `--context <id>`.
- Safari registers as the stable context `safari`; route with `interceptor --context safari <verb>`. If it is absent, verify the notarized Interceptor Safari extension is enabled before attempting page commands. Safari's enable switch is a protected user-present action; never try to bypass its Touch ID/password gate.
- Prefer structured reads (`read`, `tree`, `text`, `inspect`, `scene`) before screenshots. Open `references/screenshot-policy.md` before screenshot-heavy work.
- Passwords and passcodes are typed by name from the keychain-backed vault: `interceptor type <ref> --secret <name>`. The daemon checks the tab's host against the secret's allowlist (`browser:<host>`) and the monitor records `***SECURE***`. Never put a credential in a literal `type` call or ask the user to paste one into chat; ask them to run `interceptor macos secret register <name> --target browser:<host>`.
- If the password is already saved in a Chromium browser (Chrome, Brave, Vivaldi, Edge, Chromium, Arc), skip registration and fill it straight from that browser's store: `interceptor type <ref> --browser-login <host> [--user] [--browser <key>]` (password by default, username with `--user`; `--browser` restricts to one browser, default searches all installed). The daemon reads and decrypts the saved login; the requested host must match the live tab, so a page only ever fills its own credential. `interceptor browser creds list [--host <host>] [--browser <key>]` shows which hosts have a saved login (host + username + browser only, no passwords). macOS only; the value never reaches argv, logs, or your output.
- Default to plain text output. Use `--json` only when piping into scripts or when a downstream tool needs a machine-readable contract.
- Unknown flags are rejected (exit 1, naming the flag and command) rather than ignored, so a typo never reads as success; `screenshot` writes to disk with `--save`, not `--out`. Fix the flag instead of setting `INTERCEPTOR_LAX_FLAGS=1`.
- A verb whose result is a failure prints `error: …` and exits non-zero (every browser verb, including `back`/`forward` with no history). Check `$?` in scripts; do not grep stdout for `error:` to detect failure.
- `eval --main` can recover from strict CSP by stripping the blocking header and reloading the tab. The result discloses that reload. Treat it as state-changing because unsaved page state can be lost; task verification disables this recovery.
- If an already-loaded unpacked extension behaves stale after a package update, reload it from `chrome://extensions` or `brave://extensions`, or run `interceptor reload` once the extension is reachable.
- Safari package updates are loaded through the containing app/appex; do not look for a Chrome-style unpacked-extension reload button.
- Safari suspends its background worker when idle, so `--context safari` can briefly report "context 'safari' not found" between commands and then self-heal. Re-issue the command rather than treating one transient drop as failure. Note two Safari capability limits: `headers add` only modifies recognized standard headers (arbitrary `X-…` names are refused — use `override` instead), and passive `net` capture reflects genuine page traffic, not requests you originate from `eval` (its world is separate from the page's).

## Fast Path

```bash
interceptor status                        # 1. Confirm daemon + extension are alive
interceptor websearch "example docs"      # 2a. Default provider → managed background results tab
interceptor open "https://example.com"    # 2b. Or open a known URL → wait + tree + text
interceptor read                          # 3. Current state (re-read after any mutation)
interceptor act e5                        # 4. Click ref e5 (refs come from `read`)
interceptor act e7 "example user"         # 5. Type into ref e7
interceptor inspect                       # 6. Tree + text + network in one read
```

Inside this repo without `interceptor` on PATH, use `./dist/interceptor ...`.

## Workflows

Each workflow is a complete self-contained "you are doing X" procedure. Open the file when the task matches.

| Workflow | When to invoke |
|---|---|
| [`workflows/verify-deploy.md`](workflows/verify-deploy.md) | "Verify the deploy", "check that X works on the page", reproducing a bug before touching code |
| [`workflows/read-and-extract.md`](workflows/read-and-extract.md) | Compound page read + SPA state extraction — pull a specific value off a page |
| [`workflows/drive-rich-editor.md`](workflows/drive-rich-editor.md) | Canva, Google Docs, Google Slides, design-tool layer manipulation — anything where DOM refs aren't enough |
| [`workflows/rich-editor-workflows.md`](workflows/rich-editor-workflows.md) | Canva shape insertion, Docs table build+fill, Slides table insert — what works natively vs the `eval --main` last mile |
| [`workflows/task-state.md`](workflows/task-state.md) | Durable task checkpoints, scoped lessons, compact resume and fresh browser completion checks |
| [`workflows/google-docs-fill-empty-table-cells.md`](workflows/google-docs-fill-empty-table-cells.md) | Fill empty Docs table cells with the value above (canvas caret + per-char typing + Tab) |
| [`workflows/canva-custom-size-creation.md`](workflows/canva-custom-size-creation.md) | Create a custom-size Canva design from home (normalized semantic replay) + monitor launch/handoff pattern |
| [`workflows/cook-in-canvas.md`](workflows/cook-in-canvas.md) | Draw effects/markers directly through a page's own `CanvasRenderingContext2D` (Docs/Excalidraw), pixel-verified |
| [`workflows/cook-on-top-of-pages.md`](workflows/cook-on-top-of-pages.md) | "Cook" a live page in-place — banners, HUDs, overlays that track real DOM, full-screen takeovers, over the real session |
| [`workflows/override-xhr.md`](workflows/override-xhr.md) | Mutate a request before it hits the server — change params, force a status, throttle |
| [`workflows/capture-page-communication.md`](workflows/capture-page-communication.md) | Capture WebSocket, Beacon, and BroadcastChannel activity without CDP |
| [`workflows/record-and-replay.md`](workflows/record-and-replay.md) | Learn a real user flow, export a replay plan, run it back |
| [`workflows/screenshot-for-vlm.md`](workflows/screenshot-for-vlm.md) | Take a screenshot the model will actually understand — VLM-budgeted, WebP, on-disk |
| [`workflows/multi-page-compare.md`](workflows/multi-page-compare.md) | Compare facts across multiple pages (e.g. "who designed Python vs JavaScript") — sequential `open --text-only` per page |

## References

| File | Topic |
|---|---|
| [`references/browser-and-network.md`](references/browser-and-network.md) | Command selection, SPA extraction, request overrides, SSE capture, page-world `eval --main` cautions |
| [`references/page-communication-capture.md`](references/page-communication-capture.md) | P1 WebSocket, Beacon, and BroadcastChannel capture mechanics, commands, event shapes, and limits |
| [`references/rich-editors.md`](references/rich-editors.md) | Overview: Canva, Google Docs, Google Slides behavior, canvas-rendered editor input, WebGL camera apps, blob export capture (deep mechanics in the four `references/canvas-*`/`webgl-*`/`blob-*` files below) |
| [`references/canvas-rendered-editor-input.md`](references/canvas-rendered-editor-input.md) | Deep mechanic: caret / typing / key-nav inside canvas-rendered editors (Docs/Slides/Sheets) via dispatched events + iframe-window `KeyboardEvent`. The `eval --main` + `__interceptor_trust`/`userActivation` foundation lives here. |
| [`references/canvas-camera-overlays.md`](references/canvas-camera-overlays.md) | Deep mechanic: pan/zoom a WebGL map viewer + lat/lng DOM overlays (Web Mercator), URL-watcher pattern, CSS-filter restyle |
| [`references/webgl-camera-control.md`](references/webgl-camera-control.md) | Deep mechanic: generic, app-agnostic WebGL camera control + overlay anchoring |
| [`references/blob-export-capture.md`](references/blob-export-capture.md) | Deep mechanic: capture a webapp's client-side export bytes (PNG/PDF/SVG) with no Save dialog |
| [`references/monitor-and-replay.md`](references/monitor-and-replay.md) | Monitor session behavior, replay-plan generation, cross-tab/focus-follow notes |
| [`references/command-catalog.md`](references/command-catalog.md) | Full browser command surface with flags and examples |
| [`references/screenshot-policy.md`](references/screenshot-policy.md) | VLM-aware screenshot budget table; agent-default recipe |

## When To Switch Surfaces

If the target is **outside the page** - a native dialog, browser chrome (URL bar, profile picker), Save/Open file picker, OS notification, or any non-browser macOS app - load `interceptor-macos` instead.

If the target is an **Electron / Chromium desktop app's web contents** (Slack, VS Code, Notion, Descript, etc.), use the CDP/app reference from `interceptor-macos`: `references/cdp-app.md`.

If the task is **breadth research** — "investigate / go deep on / find everything about X" across many sources — load `interceptor-research`, which layers a planner loop, source ledger, and verification pass on top of this surface.

## Do Not Default To Troubleshooting

- User wants a browser task completed → run Interceptor commands.
- User wants Interceptor fixed, installed, or explained → that's a separate task; ask before diving into repo state.
- Inside the Interceptor repo, use this skill for live browser validation, not as the primary source of repo-development instructions.

## Completion

A browser job is complete only when:

- every claim about page state comes from a re-read (`read`/`inspect`) taken *after* the last mutation, not from the action's success alone;
- artifacts you produced (screenshots, saved files, captured payloads) are named by absolute path in the report;
- your tab group is closed (`interceptor group close <label>`) and `interceptor group list` no longer shows it — the list output is the proof, not the close command's exit code.

Report what failed or was skipped as prominently as what worked. Never report only the happy fields.
