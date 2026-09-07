/**
 * cli/global-flags.ts — global CLI flag filtering shared by index and tests
 */

export function buildFilteredArgs(args: string[]): string[] {
  const skipIndices = new Set<number>()
  const optionTerminator = args.indexOf("--")
  const optionEnd = optionTerminator === -1 ? args.length : optionTerminator

  const leadingValueFlags = new Set(["--frame", "--tab", "--context", "--group", "--group-color"])
  const leadingBooleanFlags = new Set(["--json", "--ws", "--no-ws", "--any-tab", "--shared-group", "--changes", "--all-surfaces", "--no-skills-hint", "--no-research-hint"])
  let commandIndex = -1
  for (let i = 0; i < optionEnd; i++) {
    const name = args[i].split("=", 1)[0]
    if (leadingValueFlags.has(name)) {
      if (args[i] === name) i++
      continue
    }
    if (leadingBooleanFlags.has(args[i])) continue
    commandIndex = i
    break
  }
  const nativeSurface = args[commandIndex] === "macos" || args[commandIndex] === "ios"

  args.forEach((arg, index) => {
    if (index >= optionEnd) return
    if (arg === "--ws" || arg === "--any-tab" || arg === "--shared-group") skipIndices.add(index)
  })

  const optionArgs = args.slice(0, optionEnd)
  const tabIdx = optionArgs.indexOf("--tab")
  if (tabIdx !== -1) {
    skipIndices.add(tabIdx)
    if (args[tabIdx + 1] !== undefined) skipIndices.add(tabIdx + 1)
  }

  const ctxIdx = optionArgs.indexOf("--context")
  if (ctxIdx !== -1) {
    skipIndices.add(ctxIdx)
    if (args[ctxIdx + 1] !== undefined) skipIndices.add(ctxIdx + 1)
  }

  const groupIdx = optionArgs.indexOf("--group")
  if (groupIdx !== -1) {
    skipIndices.add(groupIdx)
    if (args[groupIdx + 1] !== undefined) skipIndices.add(groupIdx + 1)
  }

  const groupColorIdx = optionArgs.indexOf("--group-color")
  if (groupColorIdx !== -1) {
    skipIndices.add(groupColorIdx)
    if (args[groupColorIdx + 1] !== undefined) skipIndices.add(groupColorIdx + 1)
  }

  const filtered = args.filter((arg, index) => {
    if (index >= optionEnd) return true
    if (skipIndices.has(index)) return false
    if (arg === "--json") return nativeSurface && index > commandIndex + 1
    return true
  })
  // Native surfaces own their nested flag grammar. Browser frame selection is
  // global, including before the command, and must never enter code or text.
  if (nativeSurface) return filtered
  let terminated = false
  let frameValue = false
  return filtered.filter(arg => {
    if (terminated) return true
    if (arg === "--") { terminated = true; return true }
    if (frameValue) { frameValue = false; return false }
    if (arg === "--frame") { frameValue = true; return false }
    return !arg.startsWith("--frame=")
  })
}

export function parseFrameFlag(args: string[]): number | undefined {
  const end = args.indexOf("--")
  const options = end === -1 ? args : args.slice(0, end)
  let frameId: number | undefined
  for (let i = 0; i < options.length; i++) {
    const arg = options[i]
    if (arg !== "--frame" && !arg.startsWith("--frame=")) continue
    const value = arg === "--frame" ? options[++i] : arg.slice(8)
    if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error("--frame requires a non-negative safe integer frame ID")
    }
    if (frameId !== undefined && frameId !== Number(value)) throw new Error("conflicting --frame values")
    frameId = Number(value)
  }
  return frameId
}
