---
author: agent
generated_by: codex (Maestro)
created: 2026-09-05
updated: 2026-09-05
status: final
reviewed: false
source: daemon/ios/manager.ts; resident-runner unlock contract
---

# Workflow: drive an app on a real iPhone

You are completing a task inside an app on the user's physical iPhone. The phone is
paired and the runner is installed (`interceptor ios devices` lists it).

## Procedure

1. **Confirm the phone.** `interceptor ios devices`. Note the alias (set one with
   `interceptor ios name <udid> phone` if missing). Use `--on phone` from here on.

2. **Open the target app.** `interceptor ios app launch <bundleId> --on phone`.
   Get the bundle id from `interceptor ios apps --on phone` if you don't know it.
   Immediately follow with a `tree` — the runner can drop on idle and re-land on the
   Home screen if you pause, so keep launch and follow-up verbs close together.

3. **Read the screen.** `interceptor ios tree --on phone`. This is the ref-tagged
   element tree. Use `--filter interactive` to trim to actionable elements.

4. **Locate what you need.** `interceptor ios find --label "..." [--role button] --on phone`
   returns refs with frames. Or read the ref directly from the tree.

5. **Act.**
   - Tap: `interceptor ios click <ref> --on phone` (deterministic coordinate tap).
   - Enter text: `interceptor ios type <ref> "text" --on phone` — this focuses the
     field then types, which survives handle staleness. Append with
     `interceptor ios keys " more" --on phone`.
   - Scroll: `interceptor ios scroll --dir down --on phone`.

6. **Verify.** Re-read with `interceptor ios tree` (refs change after navigation) or
   `interceptor ios screenshot --on phone` and inspect the image. Never assume an
   action landed — confirm from a fresh read.

## Pitfalls

- **Stale refs.** `eN` refs reflect the screen at `tree` time only. Re-read after any
  navigation before acting.
- **Locked phone.** Launches stall on a locked device. If a launch hangs, the phone is
  probably locked — unlock it, then retry.
- **`keys` vs `type`.** `keys` types into whatever is currently focused; if focus was
  lost (idle reconnect), it goes nowhere. Prefer `type <ref>` when a field is known —
  it focuses atomically.
- **Resident unlock only.** A connected runner can attempt `ios unlock --secret
  ios-passcode`; success requires an observed unlocked state. `--probe` reports
  state without typing. A disconnected runner cannot launch on a locked phone,
  so unlock once and connect with `ios tree` first. Face ID and Apple Pay approvals
  remain user-present actions.
