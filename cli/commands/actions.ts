/**
 * cli/commands/actions.ts — click, type, select, hover, drag, dblclick, rightclick,
 *                           check, keys, focus, blur, click-at, what-at, regions
 */

import { parseElementTarget } from "../parse"
import { hasTrustedFlag, TRUSTED_FLAG_VALUES } from "./flags"
import { inferMime, baseName } from "../../shared/upload"
import { MAX_UPLOAD_FILE_BYTES } from "../../shared/platform"
import { readFileSync } from "node:fs"

type Action = { type: string; [key: string]: unknown }

function parseAt(filtered: string[]): { x?: number; y?: number } {
  if (filtered.includes("--at")) {
    const parts = filtered[filtered.indexOf("--at") + 1].split(",").map(Number)
    return { x: parts[0], y: parts[1] }
  }
  return {}
}

export function parseActionsCommand(filtered: string[], positionalCount?: number): Action {
  const cmd = filtered[0]

  switch (cmd) {
    case "click": {
      const useOs = hasTrustedFlag(filtered)
      // Click by CSS SELECTOR.
      //
      // `click` resolved only a11y refs/indices, while `query` locates elements
      // by selector and returns no ref. On any page whose a11y tree comes back
      // empty the tool could therefore SEE an element and be unable to click
      // it — the two halves never met. Observed on perplexity.ai answer pages,
      // where the tree is empty while `query "button span"` finds the control
      // exactly.
      const selIdx = filtered.indexOf("--selector")
      const nthIdx = filtered.indexOf("--nth")
      if (selIdx !== -1) {
        const selector = filtered[selIdx + 1]
        // A missing operand leaves the next token undefined or another flag —
        // erroring beats falling through to parseElementTarget("--selector").
        if (!selector || selector.startsWith("--")) {
          console.error('error: --selector requires a CSS selector value. Quote selectors containing spaces, e.g. --selector "button span"')
          process.exit(1)
        }
        let nth = 0
        if (nthIdx !== -1) {
          const rawNth = filtered[nthIdx + 1]
          nth = Number(rawNth)
          if (!Number.isInteger(nth) || nth < 0) {
            console.error(`error: --nth requires a non-negative integer (0-based, matching query output), got '${rawNth ?? ""}'`)
            process.exit(1)
          }
        }
        return { type: "click_selector", selector, nth, ...parseAt(filtered) }
      }
      if (nthIdx !== -1) {
        console.error("error: --nth requires --selector")
        process.exit(1)
      }
      const target = parseElementTarget(filtered[1])
      const at = parseAt(filtered)
      if (useOs) {
        return { type: "os_click", ...target, ...at }
      } else if (target.semantic) {
        return { type: "find_and_click", name: target.semantic.name, role: target.semantic.role, ...at }
      } else {
        return { type: "click", ...target, ...at }
      }
    }

    case "type": {
      const append = filtered.includes("--append")
      const useOs = hasTrustedFlag(filtered)
      const target = parseElementTarget(filtered[1])
      // Normalized argv is [cmd, ...positionals, ...flags]; the typed text is
      // the positional span after the target. Sweeping everything after index 2
      // used to ingest flags AND their values (`type e1 999 --frame 4897` typed
      // "999 --frame 4897" — issue #217). The filter fallback keeps direct
      // callers (tests) that don't pass the boundary working.
      const textArgs = positionalCount !== undefined
        ? filtered.slice(2, positionalCount + 1)
        : filtered.slice(2).filter(a => a !== "--append" && a !== "--user" && !TRUSTED_FLAG_VALUES.includes(a) && a !== "--secret" && a !== "--chrome-login" && filtered[filtered.indexOf(a) - 1] !== "--secret" && filtered[filtered.indexOf(a) - 1] !== "--chrome-login")
      // issue #244: `--secret <name>` types a vault value by name. The daemon
      // resolves it after logging and checks the page host against the
      // secret's allowlist; the CLI process never holds the value.
      const secretIdx = filtered.indexOf("--secret")
      if (secretIdx !== -1) {
        const secretName = filtered[secretIdx + 1]
        if (!secretName || secretName.startsWith("--")) { console.error("error: --secret requires a secret name"); process.exit(1) }
        if (textArgs.join("").length) { console.error("error: --secret and literal text are mutually exclusive"); process.exit(1) }
        if (useOs) return { type: "os_type", ...target, secret: secretName }
        if (target.semantic) return { type: "find_and_type", name: target.semantic.name, role: target.semantic.role, secret: secretName, clear: !append }
        return { type: "input_text", ...target, secret: secretName, clear: !append }
      }
      // issue #248: `--chrome-login <host>` fills a field from Chrome's own
      // saved logins for the current page. `--user` picks the username, else
      // the password. The daemon reads and decrypts the credential, verifies
      // the requested host matches the live page host, and delivers the value
      // by the same leaked-proof legs as --secret; the CLI never holds it.
      const chromeIdx = filtered.indexOf("--chrome-login")
      if (chromeIdx !== -1) {
        const host = filtered[chromeIdx + 1]
        if (!host || host.startsWith("--")) { console.error("error: --chrome-login requires a host (e.g. --chrome-login my.functionhealth.com)"); process.exit(1) }
        if (secretIdx !== -1) { console.error("error: --chrome-login and --secret are mutually exclusive"); process.exit(1) }
        if (textArgs.join("").length) { console.error("error: --chrome-login and literal text are mutually exclusive"); process.exit(1) }
        const field = filtered.includes("--user") ? "user" : "pass"
        const chromeLogin = { host, field }
        if (useOs) return { type: "os_type", ...target, chromeLogin }
        if (target.semantic) return { type: "find_and_type", name: target.semantic.name, role: target.semantic.role, chromeLogin, clear: !append }
        return { type: "input_text", ...target, chromeLogin, clear: !append }
      }
      if (useOs) {
        return { type: "os_type", ...target, text: textArgs.join(" ") }
      } else if (target.semantic) {
        return { type: "find_and_type", name: target.semantic.name, role: target.semantic.role, inputText: textArgs.join(" "), clear: !append }
      } else {
        return { type: "input_text", ...target, text: textArgs.join(" "), clear: !append }
      }
    }

    case "select":
      return { type: "select_option", ...parseElementTarget(filtered[1]), value: filtered[2] }

    case "focus":
      if (!filtered[1]) {
        return { type: "get_focus" }
      } else {
        return { type: "focus", ...parseElementTarget(filtered[1]) }
      }

    case "blur":
      return { type: "blur" }

    case "hover": {
      const hoverAction: Action = { type: "hover", ...parseElementTarget(filtered[1]) }
      if (filtered.includes("--from")) {
        const fromParts = filtered[filtered.indexOf("--from") + 1].split(",").map(Number)
        hoverAction.fromX = fromParts[0]
        hoverAction.fromY = fromParts[1]
      }
      if (filtered.includes("--steps")) {
        hoverAction.steps = parseInt(filtered[filtered.indexOf("--steps") + 1])
      }
      return hoverAction
    }

    case "drag": {
      const dragAction: Action = { type: "drag", ...parseElementTarget(filtered[1]) }
      if (filtered.includes("--from")) {
        const fromParts = filtered[filtered.indexOf("--from") + 1].split(",").map(Number)
        dragAction.fromX = fromParts[0]
        dragAction.fromY = fromParts[1]
      }
      if (filtered.includes("--to")) {
        const toParts = filtered[filtered.indexOf("--to") + 1].split(",").map(Number)
        dragAction.toX = toParts[0]
        dragAction.toY = toParts[1]
      }
      if (filtered.includes("--steps")) dragAction.steps = parseInt(filtered[filtered.indexOf("--steps") + 1])
      if (filtered.includes("--duration")) dragAction.duration = parseInt(filtered[filtered.indexOf("--duration") + 1])
      return dragAction
    }

    case "upload": {
      const ref = filtered[1]
      const path = filtered[2]
      if (!ref || !path) {
        console.error("error: usage — interceptor upload <ref|index> <path> [--dropzone]")
        process.exit(1)
      }
      const target = parseElementTarget(ref)
      let buf: Buffer
      try {
        buf = readFileSync(path)
      } catch (e) {
        console.error(`error: cannot read file '${path}': ${(e as Error).message}`)
        process.exit(1)
      }
      const fileName = baseName(path)
      // Preflight: fail fast + honest above the ceiling instead of
      // letting an oversized base64 payload hang to a silent 15s timeout.
      if (buf.byteLength > MAX_UPLOAD_FILE_BYTES) {
        const mb = (buf.byteLength / (1024 * 1024)).toFixed(1)
        const capMb = (MAX_UPLOAD_FILE_BYTES / (1024 * 1024)).toFixed(0)
        console.error(`error: '${fileName}' is ${mb} MB; the upload transport tops out at ${capMb} MB. Split the file or use a smaller one.`)
        process.exit(1)
      }
      const action: Action = {
        type: "file_upload",
        ...target,
        fileName,
        mimeType: inferMime(fileName),
        dataBase64: buf.toString("base64"),
      }
      if (filtered.includes("--dropzone")) action.dropzone = true
      // Force the File System Access API picker-staging path for
      // sites whose trigger opens showOpenFilePicker() instead of a file input.
      if (filtered.includes("--picker")) action.picker = true
      return action
    }

    case "dblclick": {
      return { type: "dblclick", ...parseElementTarget(filtered[1]), ...parseAt(filtered) }
    }

    case "rightclick": {
      return { type: "rightclick", ...parseElementTarget(filtered[1]), ...parseAt(filtered) }
    }

    case "check":
      return { type: "check", ...parseElementTarget(filtered[1]), checked: filtered[2] !== "false" }

    case "keys": {
      if (hasTrustedFlag(filtered)) {
        const parts = filtered[1].split("+")
        const key = parts[parts.length - 1]
        const modifiers = parts.slice(0, -1)
        return { type: "os_key", key, modifiers }
      } else {
        return { type: "send_keys", keys: filtered[1] }
      }
    }

    case "click-at": {
      const coords = filtered[1]?.split(",").map(Number)
      if (!coords || coords.length !== 2 || coords.some(isNaN)) {
        console.error("error: click-at requires X,Y coordinates. Usage: interceptor click-at 500,300")
        process.exit(1)
      }
      return { type: "click_at", x: coords[0], y: coords[1] }
    }

    case "what-at": {
      const coords = filtered[1]?.split(",").map(Number)
      if (!coords || coords.length !== 2 || coords.some(isNaN)) {
        console.error("error: what-at requires X,Y coordinates. Usage: interceptor what-at 500,300")
        process.exit(1)
      }
      return { type: "what_at", x: coords[0], y: coords[1] }
    }

    case "regions":
      return { type: "regions" }

    default:
      console.error(`error: unknown actions command '${cmd}'`)
      process.exit(1)
  }
}
