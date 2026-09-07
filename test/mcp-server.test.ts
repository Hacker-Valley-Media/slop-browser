import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import { COMMAND_SPECS } from "../cli/manifest"
import { buildServer } from "../cli/mcp/server"
import { withGlobalFlags } from "../cli/mcp/adapter"

describe("buildServer", () => {
  test("invalid monitor flags return errors without terminating the MCP process", async () => {
    const script = `
      import assert from "node:assert/strict";
      import { Client } from "@modelcontextprotocol/sdk/client/index.js";
      import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
      import { buildServer } from ${JSON.stringify(resolve("cli/mcp/server.ts"))};
      const server = buildServer();
      const client = new Client({ name: "regression", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a); await client.connect(b);
      for (const flag of ["--typo", "--json=true"]) {
        const result = await client.callTool({ name: "interceptor_browser", arguments: { verb: "monitor", args: ["task", "resume", "task-123", flag] } });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /unknown flag|does not take a value/);
        assert.equal((await client.listTools()).tools.length, 6);
      }
      const gated = await client.callTool({ name: "interceptor_browser", arguments: { verb: "monitor", args: ["--json", "task", "verify", "task-123"] } });
      assert.equal(gated.isError, true);
      assert.match(JSON.stringify(gated), /arbitrary-exec/);
      await client.close(); await server.close();
    `
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, INTERCEPTOR_LAX_FLAGS: "0", INTERCEPTOR_MCP_ALLOW: "" },
      stdout: "pipe", stderr: "pipe",
    })
    const code = await child.exited
    expect(code, await new Response(child.stderr).text()).toBe(0)
  })

  test("constructs without throwing and registers tools", () => {
    const server = buildServer()
    expect(server).toBeTruthy()
    // McpServer keeps registered tools on an internal map; assert the six routers exist.
    const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools
    if (tools) {
      for (const name of ["interceptor_browser", "interceptor_macos", "interceptor_ios", "interceptor_read", "interceptor_local", "interceptor_raw"]) {
        expect(Object.keys(tools)).toContain(name)
      }
    }
  })

  test("browser verb menu is non-empty (enum source of truth)", () => {
    expect(COMMAND_SPECS.filter(c => c.surface === "browser").length).toBeGreaterThan(20)
  })

  test("MCP keeps its explicit hard group instead of relying on host session scope", () => {
    expect(withGlobalFlags(["open", "https://example.com"], { group: "mcp-1234" }))
      .toEqual(["open", "https://example.com", "--group", "mcp-1234"])
  })
})
