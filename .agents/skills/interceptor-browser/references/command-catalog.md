# Browser Command Catalog

Full surface for `interceptor` (no prefix). Reference doc — load when you need flag-level detail. For task procedures, see `workflows/`. For the input-layer routing rules, see `browser-and-network.md`.

## Open + Read

```bash
interceptor open <url>                             # Open + wait + tree + text
interceptor open <url> --full | --tree-only | --text-only
interceptor open <url> --timeout 15000
interceptor open <url> --reuse                     # Navigate latest managed tab instead of creating
interceptor open <url> --no-reuse                  # Force a new tab (overrides the named-group reuse default)

interceptor read                                   # Current page tree + text
interceptor read e12 [--tree-only | --text-only]   # Scoped sub-tree
interceptor read --markdown [--text-only]          # Page text rendered as markdown (preserves headings, **bold**, lists, tables)
interceptor read --include-style
interceptor read --include-frames                  # Descend into iframes
interceptor read e2_7 --include-frames --tree-only # Framed ref
interceptor text --markdown                        # Standalone markdown dump
interceptor text e12 --markdown                    # Element rendered as markdown

interceptor websearch "<query>"                    # Configured default provider → managed background tab + tree/text
interceptor websearch "<query>" --text-only --full
interceptor websearch "<query>" --reuse             # Reuse the latest managed tab
interceptor websearch "<query>" --no-reuse          # Force a new managed tab
interceptor websearch "<query>" --activate          # Explicitly foreground the destination
interceptor websearch "<query>" --no-wait           # Return after provider dispatch
```

In a **named group**, including an automatic session group, `open` reuses that group's most-recent tab **by default** (address-bar semantics; policy set in the extension popup) — pass `--no-reuse` to keep the current page and open another. Shared-default `open` and `tab new` create by default; `--reuse` opts in per call. Reading strategy: start with `read`/`open`, not a screenshot. Re-read after every mutating action.

**`--markdown` is a SWAP for `--text-only`, not an extra command.** It renders the same content with structure preserved (`<strong>` → `**bold**`, `<h1-6>` → `#`/`##`/..., lists, tables). Use it *instead of* plain `--text-only` when the task asks for the "exact text" / "exact summary" of a section, or the page has visually emphasized text near plain descriptive copy — markdown lets you tell the real answer from decoy or instructional prose. **Never run both modes** — pick one and commit. Skip markdown for raw fact lookups (single date, name, number) where flat text is enough.

## Find + Act

```bash
interceptor find "Submit"
interceptor find "Email" --role textbox
interceptor find "contract clause" --text-only     # Complete rendered-text snapshot; bounded snippets
interceptor find "Submit" --elements-only          # Accessible controls + actionable refs only
interceptor read --include-frames                   # Populate child-frame element refs
interceptor find "privacy" --include-frames        # Frame IDs + framed refs such as e2_7

interceptor act e7                                 # Click + read after
interceptor act e9 "example user"                  # Type into field
interceptor act e11 --keys "Enter"
interceptor act e15 --trusted                      # HID-sourced click; page sees isTrusted: true. ESCALATION ONLY.
interceptor act e20 --no-read
# act takes the ref directly (act e5, never act click e5). A timeout or closed channel after dispatch
# is reported as unverified delivery: read the target before retrying so you do not click twice.
```

**After `act --trusted` reports success, read the page once and commit.** Do not re-execute the same click via a different surface (`interceptor macos click ...`, manual coordinates, etc.) to "verify" — the page's own state is the verification, and the trusted event is the same trusted event regardless of which surface posted it. Escalating to a different surface to redo a successful browser action is the most common way to blow the command budget. `interceptor macos` remains the right surface for native-app tasks; this rule only constrains within-task redo behavior on the browser.

Unqualified `find` returns two typed current-page sections: literal case-insensitive matches from the complete `document.body.innerText` snapshot, and semantic accessible-element matches. It does not navigate, scroll, focus, or highlight. `--limit` caps returned matches per category while preserving total counts. Low-level actions when `act` is not enough:

```bash
interceptor click e7
interceptor click --selector "button span" --nth 4   # CSS-selector click; 0-based --nth matches query output; quote selectors with spaces
interceptor type e9 "..."
interceptor keys "Meta+K"
interceptor select e12 "Option label"
interceptor hover e3 | drag e4 e8 | dblclick e5 | rightclick e5
```

On pages whose a11y tree comes back empty (some SPAs render nothing tree-visible), `interceptor query "<css>"` still finds elements — and each result carries a clickable `e<ref>`, so every ref verb (`click`, `type`, `check`, …) works on what query found. A navigating click resolves as `{navigated: true, url}` rather than an error; a selector click that produces no DOM change auto-escalates to an OS-level click when the OS transport is available.

## Inspection + Network

```bash
interceptor inspect                                # Tree + text + passive network
interceptor inspect --net-only
interceptor inspect --filter api
```

Passive network (preferred over CDP):

```bash
interceptor net log [--filter <p>] [--since 30s] [--limit 100]
interceptor net log --format json|har|pcapng [--out <path>] [--redact-auth]   # file is 0600; headers kept unless --redact-auth
interceptor net headers [--filter <p>]
interceptor net clear
```

Overrides (declarativeNetRequest — no debugger banner):

```bash
interceptor override "*api/search*" status=500
interceptor override "*api/search*" delay=1000
interceptor override "*api/search*" status=200 body='{"results":[]}'
interceptor override clear
```

CDP only when passive `net` is insufficient:

```bash
interceptor network on | log | off
interceptor network override "*api*" status=500
```

SSE:

```bash
interceptor sse streams | log | tail
```

Page communication (WebSocket / Beacon / BroadcastChannel, no CDP):

```bash
interceptor net page-comm log [--type ws|beacon|broadcast] [--filter <text>] [--limit 100]
interceptor net page-comm clear
interceptor net monitor on [--reload] [--filter "https://example.com/*"]
interceptor net monitor status
interceptor net monitor off
```

Use `net monitor on --reload` when the WebSocket or BroadcastChannel is created
during page startup. For mechanics and limits, see `page-communication-capture.md`.

## Byte Export

Save page-produced bytes without CDP, browser downloads, Save dialogs, or
clipboard:

```bash
interceptor save --json --context <ctx> --tab <id> --out /abs/path/file.bin "window.someBlobOrUint8Array"
interceptor save --json --context <ctx> --tab <id> --out /abs/path/file.bin "blob:https://example.com/..."
interceptor save --json --context <ctx> --tab <id> --out /abs/path/file.txt "new Blob([text], {type:'text/plain'})"
```

Supported expression results: `Blob`, `File`, `ArrayBuffer`, typed arrays,
`blob:` URL strings, and objects with `url`/`blobUrl`/`href`. Use an absolute
output path (the sink writes anywhere the daemon's user can write).

`save` must be the **first token** so the CLI auto-selects the WebSocket sink
path. Other flags (`--json`, `--context`, `--tab`, `--isolated`, `--chunk-size`)
may now appear in any position — the parser keeps them out of the evaluated
expression. The response includes `sha256`, `bytes`, and `chunks`; the daemon
discards the file and fails if the written byte count doesn't match the source,
so a reported success is integrity-checked. Strict-CSP / Trusted-Types pages
work too — `save` reuses the same CSP-strip + reload bypass as `eval`.

## Canvas

```bash
interceptor canvas list | status | model | routes
interceptor canvas log [N] [--kind fillText]
interceptor canvas objects [N] [--kind text]
```

`log` / `objects` / `status` read the observer that runs in the page's own MAIN-world realm, so they reflect what the page actually drew. Pass `N` (a `canvas list` index) to scope to one canvas; omit it for all canvases.

Pixels only when observer data is insufficient:

```bash
interceptor canvas read 1 [--format png] [--region 10,20,300,120] [--webgl]
interceptor canvas diff 1
interceptor canvas ocr 1                           # Native canvas text: aria/fallback + semantic model (no pixel OCR)
```

`canvas ocr` returns the canvas's *native* accessible text (aria-label / aria-labelledby / fallback subtree / figcaption) plus the page's semantic textbox model — no pixel OCR. For a canvas-rendered editor prefer `scene text`; for genuine pixel-only text use `interceptor macos vision text` (native macOS Vision OCR).

Canvas indexes are DOM canvas indexes.

## Scene (rich editors)

For Canva, Google Docs/Slides/Sheets. Run `scene profile` first.

```bash
interceptor scene profile [--verbose]
interceptor scene list [--type text]
interceptor scene hit 400 300
interceptor scene click <scene-ref> [--trusted]   # --trusted posts OS-level input for isTrusted-gated canvases
interceptor scene dblclick | select | cursor-to <scene-ref>
interceptor scene selected
interceptor scene text <scene-ref> [--with-html]
interceptor scene insert "New text"

interceptor scene slide list | current | goto 3
interceptor scene notes | render | zoom 100
```

For canvas-rendered editor input and camera apps, see `rich-editors.md`.

## Navigation + Tabs

```bash
interceptor navigate <url>
interceptor back
interceptor forward
interceptor scroll down
interceptor wait 1000
interceptor wait-stable

interceptor tabs
interceptor tab new <url>             # Background tab in the interceptor group
interceptor tab new <url> --activate  # Explicit foregrounding
interceptor tab new <url> --reuse     # Navigate the group's most-recent tab instead of creating
interceptor tab switch <tab-id>
interceptor tab close <tab-id>

interceptor open <url> --group <label>   # Open into a named per-agent group "<brand>-<label>" (created on first use)
interceptor read --group <label>         # Any command scopes to that group's tabs; env INTERCEPTOR_GROUP is the fallback.
                                         # No explicit scope: supported agent shells get a soft session group (s-<hash16>).
interceptor open <url> --shared-group     # Suppress session scope; use the shared default Interceptor group.
interceptor group list                   # All live tab groups: label, title, color, tab count
interceptor group close <label>          # Atomically close every tab in a named group (other groups untouched)
interceptor window list
interceptor window new
interceptor window focus <window-id>                      # Explicit focus move
interceptor window resize <window-id> <width> <height>
interceptor window resize <window-id> --left 0 --top 0 --width 960 --height 1080
interceptor window resize --state maximized               # Don't combine maximized/fullscreen/minimized with geometry
```

Use `--tab <id>` for a specific tab; `--any-tab` only when explicitly authorized.

Solo agent work needs no label: `INTERCEPTOR_SESSION_ID` is the neutral session contract, and verified Maestro, Claude Code, and Codex variables are detected automatically. Interceptor hashes the full id into `s-<hash16>` and sends only that opaque label. The scope is SOFT: it supplies tab reuse and idle cleanup, but an empty session group can fall back to the active managed tab. Concurrent lanes often share one host session id, so each lane needs its own `--group lane-<n>` or `INTERCEPTOR_SESSION_ID`. An explicit `--group <label>` or non-empty `INTERCEPTOR_GROUP` provides HARD isolation by default: resolution stays in the named group and cross-group targets are rejected unless `--any-tab` is explicitly authorized. `--shared-group` or empty `INTERCEPTOR_GROUP=` suppresses session scope but still uses the shared default Interceptor group. Labels match `[A-Za-z0-9_-]{1,32}`. Pick a color with `--group-color <grey|blue|red|yellow|green|pink|purple|cyan|orange>` on first open. Close your group when the job is done, then use `group list` as proof. The extension auto-closes groups after 10 minutes without tab activity by default; metadata polls do not keep them alive.

## Cookies / Storage / History / Bookmarks

```bash
interceptor cookies example.com
interceptor cookies set '{"url":"https://example.com","name":"sid","value":"..."}'
interceptor cookies delete https://example.com sid

interceptor storage <key>
interceptor storage set <key> <value>
interceptor storage delete <key>
interceptor storage <key> --session                # sessionStorage instead

interceptor history "search term"
interceptor bookmarks "query"
interceptor bookmarks tree
```

## Headers

Tab-scoped request-header rewrites:

```bash
interceptor headers add x-debug 1
interceptor headers remove x-debug
interceptor headers clear
```

## Batch + Raw

```bash
interceptor batch '[{"type":"click","ref":"e5"},{"type":"wait","ms":500},{"type":"extract_text"}]'
interceptor batch '<json>' --stop-on-error
interceptor batch '<json>' --timeout 30000

interceptor raw '{"type":"any_action","key":"value"}'
```

`raw` sends any action verbatim — prefer named commands first.

## Contexts (multi-browser isolation)

```bash
interceptor contexts                                # List IDs of all connected browser contexts
interceptor --context <id> read                     # Route command to a specific profile
interceptor --context <id> open <url>
interceptor --context <id> act e7 "value"
interceptor --context safari read                   # Safari uses a stable context id
```

Chrome/Brave profiles auto-generate stable UUIDs on first run (stored in `chrome.storage.local`); Safari registers the fixed id `safari`. `contexts` lists all currently connected IDs. Without `--context`, commands auto-route only when exactly one context is connected; zero or multiple connected contexts fail fast and require `--context <id>`.

Primary use cases: multiple Chrome profiles logged in to different accounts, or Chrome/Brave and Safari connected to the same daemon simultaneously.

## Capabilities + Reload

```bash
interceptor capabilities                            # Available input layers
interceptor reload                                  # After extension changes during dev
```

## Branding (white-label)

```bash
interceptor brand tab-group --title "Acme"                # Rename the managed tab group at runtime
interceptor brand tab-group --title "Acme" --color blue   # Title + color (grey|blue|red|yellow|green|pink|purple|cyan|orange)
```

Runtime-configurable — no rebuild, no options page. Resolved from `chrome.storage` (precedence `managed` > `local` > built-in default `interceptor`/`cyan`) and applied live to the tab-strip group. Settable here, from the toolbar popup, or via an enterprise managed policy.

## Eval (escape hatch)

```bash
interceptor eval --main "document.title"
interceptor eval --main "window.__APP_STATE__"
interceptor eval "document.title" --frame 4897        # Exactly that frame; a missing frame fails
interceptor --frame 4897 eval "document.title"        # --frame is global: before or after the command
```

Use only when no built-in command exposes what you need. Thrown exceptions, rejected promises, and syntax errors are failures (exit 1) in both worlds; top-level `await` works. The default isolated world may need Allow User Scripts enabled for the extension; `--main` is an explicit page-world choice. On a strict-CSP page `--main` may strip the header and reload the tab once, and the result says so; task verification never reloads.

## Durable task state

```bash
interceptor monitor task create "Verify the saved draft"          # Returns a taskId; no recording needed
interceptor monitor task checkpoint <taskId> --file <json>        # Revisioned constraints, target, checks, lessons
interceptor monitor task resume <taskId>                          # Compact state + lessons scoped to this context/origin
interceptor monitor task verify <taskId>                          # Run the stored checks now; lifecycle unchanged
interceptor monitor task complete <taskId>                        # Completes only when every fresh check returns true
```

Checkpoint schema, locking, and verification semantics: `workflows/task-state.md`. Over MCP, `verify` and `complete` are exec tier.

## Output mode

Output is plain text by default — that is the format the LLM consumes. Use `--json` only when piping into a script or another tool that needs a machine-parseable contract. Structured JSON costs more tokens and reduces comprehension on prose-trained models.
