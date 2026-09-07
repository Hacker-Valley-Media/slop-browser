---
name: interceptor-ios
description: "Drive any installed app on an owned, unlocked, Developer-Mode iPhone via interceptor ios *: ref-tagged element trees, deterministic coordinate taps (click), reliable text entry (type/keys), scroll, drag, hardware buttons (press), screenshots, installed-app listing, and app launch/activate/terminate. The phone runs an on-device XCUITest runner (InterceptorRunner) that dials into the daemon over WiFi — no cable once paired, no WebDriverAgent. Address a phone with --on <name> or ios:<udid>; phones auto-connect on the first verb. Use for iPhone app automation. Not for the iOS Simulator UI of a Mac app, and not for content inside a browser tab (use interceptor-browser) or a macOS app (use interceptor-macos)."
metadata:
  short-description: Drive apps on a real iPhone via the interceptor CLI; device dials in over WiFi
---

# Interceptor iOS

Agent-operator skill for the iOS surface of Interceptor. Use the `interceptor ios *` CLI to drive **any installed app on an owned, unlocked, Developer-Mode iPhone**: ref-tagged accessibility trees, deterministic coordinate taps, reliable text entry, scroll/drag, hardware buttons, screenshots, and app lifecycle.

The phone runs Interceptor's own on-device **XCUITest runner** (InterceptorRunner — *not* WebDriverAgent). The runner **dials into the daemon** over a WebSocket, exactly like the browser extension; the daemon drives it from there. Once the phone is paired over WiFi, no cable is needed. For content inside a browser tab load `interceptor-browser`; for a macOS app load `interceptor-macos`.

This installed skill is self-contained. Source checkouts also have `AGENTS.md`, but packaged users may only have the skill directory below `/Library/Application Support/Interceptor/skills`.

## Fast Path

```bash
interceptor ios devices                        # 1. Phones with the agent installed (+ aliases)
interceptor ios status                          # 2. Per-phone connection state
interceptor ios tree --on phone                 # 3. Auto-connects, returns the ref-tagged element tree
interceptor ios find --label "Slack" --on phone # 4. Locate an element by label/role
interceptor ios click e29 --on phone            # 5. Deterministic coordinate tap at the ref's frame center
interceptor ios type e243 "hello" --on phone    # 6. Focus the field, then type
interceptor ios screenshot --on phone           # 7. Capture the screen (VLM-budget resized)
```

Omit `--on <name>` when only one phone is set up — it's used by default. Set an alias once with `interceptor ios name <udid> phone`, then always use `--on phone`.

Treat `eN` refs as short-lived. The UI changes between calls; **re-read with `interceptor ios tree` before acting**. Refs carry frames and resolve to coordinates, so a tap is deterministic even if the underlying element handle went stale.

## The Model

- **The device dials in.** Ordinary runner verbs auto-launch on an unlocked phone and connect back over the network. The daemon hands the runner a VPN (Tailscale) address when the Mac has one, because iOS silently denies a backgrounded runner's LAN connection until the user has granted it Local Network access (Settings › Privacy & Security › Local Network), and a VPN address is exempt from that check; `interceptor ios status` shows the address as `dialBack` / `dialBackVia`. Put the phone on the same VPN, or grant that switch once and LAN dial-back works too. Unlock and its probe require an already connected resident runner and do not auto-launch.
- **Unlocked + foreground matters.** A locked phone refuses app launches. While the runner is connected and resident, `interceptor ios unlock --secret ios-passcode` attempts vault-backed passcode entry; success requires an observed unlocked state. `ios unlock --probe` checks without typing and can succeed while reporting `locked: true`. Both commands fail immediately when disconnected, without trying to launch XCTest on a locked phone. Unlock once and run `ios tree` to connect the runner first. Keep Auto-Lock off while working.
- **Passcodes come from the vault, never from chat.** Nothing can fake Face ID or Apple Pay. On a Face ID sheet tap "Enter Passcode", then `interceptor ios type <ref> --secret ios-passcode` (or `ios keys --secret ios-passcode`); the runner types into SpringBoard when the sheet owns the keyboard. Register the passcode once with `interceptor macos secret register ios-passcode --target ios`.
- **Setup is one-time.** `interceptor ios setup` (Xcode signed in) or `interceptor ios login` (no-Xcode, the user's own Apple ID) installs + signs the runner. A background timer renews the runner signature before the free-tier certificate expires.

## Workflows

| Workflow | When to invoke |
|---|---|
| [`workflows/drive-iphone-app.md`](workflows/drive-iphone-app.md) | Open an app and complete a task on a real iPhone: launch → tree → find → click/type → verify |

## References

| File | Topic |
|---|---|
| [`references/command-catalog.md`](references/command-catalog.md) | Full `interceptor ios` command surface — setup, drive verbs, flags, addressing |

## When To Switch Surfaces

- Target is **content inside a browser tab** (DOM, network, SPA state) → load `interceptor-browser`.
- Target is a **native macOS app** (or the browser chrome / OS dialogs on the Mac) → load `interceptor-macos`.
- Target is an **app on the physical iPhone** → this skill.

## Do Not Default To Troubleshooting

- User wants an iPhone task completed → run `interceptor ios *` commands.
- User wants Interceptor's iOS support fixed, installed, or explained → that's a separate task; ask before diving into repo state.
- Inside the Interceptor repo, use this skill for live device validation, not as the primary source of repo-development instructions.
