import { describe, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { normalizeKey, npmOf, isChat, toModels, describeBalance, UNLIMITED_USD } = _internal

describe("normalizeKey", () => {
  test("补全 sk- 前缀并去空白", () => {
    expect(normalizeKey("  abc123 ")).toBe("sk-abc123")
    expect(normalizeKey("sk-abc123")).toBe("sk-abc123")
    expect(normalizeKey("")).toBe("")
  })
})

describe("npmOf", () => {
  test("按 supported_endpoint_types 选 SDK", () => {
    expect(npmOf(undefined)).toBe("@ai-sdk/openai-compatible")
    expect(npmOf(["openai", "anthropic"])).toBe("@ai-sdk/openai-compatible")
    expect(npmOf(["anthropic"])).toBe("@ai-sdk/anthropic")
    expect(npmOf(["openai-response"])).toBe("@ai-sdk/openai")
    expect(npmOf(["gemini"])).toBe("@ai-sdk/openai-compatible")
  })
})

describe("isChat", () => {
  test("过滤通配名和非对话模型", () => {
    const ok = (id, t) => isChat({ id, supported_endpoint_types: t })
    expect(ok("gpt-5.5")).toBe(true)
    expect(ok("claude-sonnet-5-5", ["anthropic", "openai"])).toBe(true)
    expect(ok("gemini-3.1-flash-lite")).toBe(true)
    expect(ok("gemini-2.5-pro-thinking-*")).toBe(false)
    expect(ok("gpt-image-2")).toBe(false)
    expect(ok("gpt-image-2.5-flare")).toBe(false)
    expect(ok("gemini-3.1-flash-image-preview")).toBe(false)
    expect(ok("gemini-embedding-001")).toBe(false)
    expect(ok("gemini-3.1-flash-tts-preview")).toBe(false)
    expect(ok("some-model", ["image-generation"])).toBe(false)
  })
})

describe("toModels", () => {
  test("合并 /v1/models，保留已有字段", () => {
    const list = {
      object: "list",
      data: [
        { id: "gpt-5.5", object: "model", owned_by: "custom", supported_endpoint_types: ["openai"] },
        { id: "claude-x", object: "model", supported_endpoint_types: ["anthropic"] },
        { object: "model" },
      ],
    }
    const out = toModels(list, { "gpt-5.5": { name: "GPT 5.5", limit: { context: 400000, output: 128000 } } })
    expect(Object.keys(out)).toEqual(["gpt-5.5", "claude-x"])
    expect(out["gpt-5.5"].name).toBe("GPT 5.5")
    expect(out["gpt-5.5"].limit.context).toBe(400000)
    expect(out["gpt-5.5"].api).toEqual({ id: "gpt-5.5", url: "https://console.anystarx.com/v1", npm: "@ai-sdk/openai-compatible" })
    expect(out["claude-x"].api.npm).toBe("@ai-sdk/anthropic")
  })
})

describe("describeBalance", () => {
  test("剩余 = 总额 - 已用", () => {
    const r = describeBalance({ hard_limit_usd: 25 }, { total_usage: 1260 })
    expect(r.balance).toBe("$12.40")
    expect(r.plan).toBe("按量付费")
  })
  test("无限额度令牌", () => {
    const r = describeBalance({ hard_limit_usd: UNLIMITED_USD }, { total_usage: 0 })
    expect(r.balance).toBeUndefined()
  })
})
