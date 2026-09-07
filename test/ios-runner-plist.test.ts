import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("the iOS runner declares its direct local-network connection", () => {
  for (const file of ["ios/InterceptorRunner/project.yml", "ios/InterceptorRunner/Generated/InterceptorRunner-Info.plist"]) {
    const text = readFileSync(file, "utf-8")
    expect(text).toContain("NSLocalNetworkUsageDescription")
    expect(text).toContain("connects to the Interceptor daemon")
  }
})
