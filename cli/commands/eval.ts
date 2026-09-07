/**
 * cli/commands/eval.ts — eval
 */

import { normalizeArgsSplit } from "../normalize"

type Action = { type: string; [key: string]: unknown }

export function parseEvalCommand(filtered: string[], positionalCount?: number): Action {
  const normalized = positionalCount === undefined ? normalizeArgsSplit(filtered) : { argv: filtered, positionalCount }
  const end = normalized.positionalCount + 1
  const world = normalized.argv.slice(end).includes("--main") ? "MAIN" : "ISOLATED"
  const code = normalized.argv.slice(1, end).join(" ")
  if (!code.trim()) throw new Error("eval requires JavaScript code. Usage: interceptor eval <code> [--main]")
  return { type: "evaluate", code, world }
}
