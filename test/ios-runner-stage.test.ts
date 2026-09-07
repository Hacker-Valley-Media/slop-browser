import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("stageRunner refreshes a cached runner when the source artifact changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ios-runner-stage-"))
  const source = join(root, "source")
  const app = join(source, "Debug-iphoneos", "Fixture-Runner.app")
  mkdirSync(app, { recursive: true })
  writeFileSync(join(source, "Fixture.xctestrun"), "fixture")
  writeFileSync(join(app, "Fixture"), "v1")
  const modulePath = resolve("daemon/ios/tools.ts")
  const script = `
    import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
    import * as os from "node:os";
    import { mock } from "bun:test";
    import { join } from "node:path";
    const realOs = { ...os };
    mock.module("node:os", () => ({ ...realOs, homedir: () => ${JSON.stringify(join(root, "home"))} }));
    const { stageRunner, buildRunnerWithXcode, installRunnerApp } = await import(${JSON.stringify(modulePath)});
    const source = ${JSON.stringify(source)};
    const staged = () => join(${JSON.stringify(join(root, "home", ".interceptor", "ios", "runner"))}, "Debug-iphoneos", "Fixture-Runner.app", "Fixture");
    if (stageRunner().error || readFileSync(staged(), "utf8") !== "v1") process.exit(2);
    writeFileSync(join(source, "Debug-iphoneos", "Fixture-Runner.app", "Fixture"), "v2");
    if (stageRunner().error || readFileSync(staged(), "utf8") !== "v2") process.exit(3);
    const derived = ${JSON.stringify(join(root, "derived"))};
    // Replace only external Xcode/install processes; exercise real build staging
    // and installer selection without touching a device or signing identity.
    Bun.spawnSync = ((args) => {
      if (args.includes("build-for-testing")) {
        const products = join(derived, "Build", "Products");
        const app = join(products, "Debug-iphoneos", "Fixture-Runner.app");
        mkdirSync(app, { recursive: true });
        writeFileSync(join(app, "Fixture"), "xcode-signed");
        writeFileSync(join(products, "Fixture.xctestrun"), "xcode-launch");
      }
      if (args.includes("install") && readFileSync(join(args.at(-1), "Fixture"), "utf8") !== "xcode-signed") throw new Error("installed unsigned bundle");
      return { success: true, exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
    });
    const built = buildRunnerWithXcode("fixture", { teamId: "FIXTURE", projectPath: source, derivedDataPath: derived });
    if (!(await installRunnerApp("fixture")).ok) throw new Error("install failed");
    if (stageRunner().error || readFileSync(staged(), "utf8") !== "xcode-signed") throw new Error("launch replaced prepared runner");
    if (readFileSync(built.xctestrunPath, "utf8") !== "xcode-launch") throw new Error("launch descriptor replaced");
    writeFileSync(join(source, "Debug-iphoneos", "Fixture-Runner.app", "Fixture"), "v3");
    if (stageRunner().error || readFileSync(staged(), "utf8") !== "v3") throw new Error("stale source was retained");
  `
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, INTERCEPTOR_IOS_USE_XCODE: "1", INTERCEPTOR_RUNNER_DIR: source },
    stdout: "pipe", stderr: "pipe",
  })
  const code = await child.exited
  const stderr = await new Response(child.stderr).text()
  expect(code, stderr).toBe(0)
  expect(readFileSync(join(root, "home", ".interceptor", "ios", "runner", "Debug-iphoneos", "Fixture-Runner.app", "Fixture"), "utf8")).toBe("v3")
  rmSync(root, { recursive: true, force: true })
})
