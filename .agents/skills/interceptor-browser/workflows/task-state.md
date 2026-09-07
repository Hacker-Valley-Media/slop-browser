---
author: agent
generated_by: codex (Maestro)
created: 2026-09-05
updated: 2026-09-05
status: final
reviewed: false
source: shared/monitor-tasks.ts; cli/commands/monitor.ts
---

# Durable task state

Use this when a task spans sessions or agents. The existing monitor task store keeps the objective, exact constraints, owner, next action, target, lessons and observed checks. It does not run an agent or replay a transcript.

1. Run `interceptor monitor task create "Verify the saved draft"` and retain the returned taskId.
2. Write a checkpoint JSON file using real context, group, tab and frame identities. Run `interceptor monitor task checkpoint <taskId> --file <absolute-path>`.
3. In a later process, run `interceptor monitor task resume <taskId>`. Read the returned constraints before acting. Only verified, matching-context/origin lessons appear in resume; lesson status is author supplied, not independently proven.
4. Run `interceptor monitor task verify <taskId>` to inspect current check results without changing lifecycle status or the recorded end time. Run `interceptor monitor task complete <taskId>` on an active task to run fresh checks and complete only when every check returns boolean true.

Task status records lifecycle history; verification records the latest observed predicates. A completed task stays completed if a later verification fails, with `verification.passed: false` and a nonzero CLI exit. Repeating `complete` on a completed or stopped task rejects before evaluating. Save a new checkpoint with the current expected revision to reopen it as active, then verify or complete. Both check commands honor global `--ws`.

Checkpoint format:

```json
{
  "expectedRevision": 0,
  "owner": "agent-session-id",
  "constraints": ["Keep the browser in the background"],
  "target": {
    "contextId": "main",
    "group": "draft-work",
    "tabId": 123,
    "frameId": 0,
    "origin": "https://example.com"
  },
  "nextAction": "Read the saved draft and check its title",
  "lessons": [],
  "checks": [{"id": "saved-title", "expression": "document.querySelector('h1')?.textContent === 'Saved draft'"}]
}
```

Use the revision returned by resume as the next `expectedRevision`. Checkpointing clears prior verification and reopens the task. A stale writer fails; it must resume before writing again. Lessons optionally contain `text`, `source`, `contextId`, `origin` and `status` (`verified`, `unverified`, or `superseded`). Preserve evidence sources and scope, and mark an obsolete workaround superseded.

Checks are author-supplied JavaScript expressions executed in MAIN on the stored hard-scoped browser target. They must return boolean true; truthy strings and objects fail. Each check compares the frame's origin before evaluation. Use side-effect-free predicates. Verification does not remove CSP or reload the page; a blocked evaluation remains a failed check. This proves only the declared predicates at their recorded times, not all user intent or future state. MCP clients need the operator's arbitrary-exec allowance and confirmation for verify/complete.

Task files stay under the existing task root (`INTERCEPTOR_TASKS_DIR` overrides it). Metadata replacement is atomic. A concurrent writer receives `task busy` and can retry after the current mutation. If a process crashed while holding `.mutation.lock`, the next mutation reclaims it only after confirming the recorded PID no longer exists and winning an exclusive reclaim claim. Live, malformed, and contested locks remain `task busy` failures.

Command reliability: `act` takes the ref directly (`act e5`, not `act click e5`). A timeout or closed channel is unverified delivery; read before retrying to avoid a duplicate action. Eval accepts `--frame N` before or after the command, preserves `--` literals, and never changes the requested frame or world. Default isolated eval can require Allow User Scripts; `--main` is an explicit page-world choice. Normal MAIN eval can disclose CSP recovery and reload, unlike task verification.
