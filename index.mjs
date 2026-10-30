// AnyStarX for magpie（https://console.anystarx.com）：
// 把 AnyStarX 添加为模型供应商，并在 magpie 里查看账户余额。
//
// AnyStarX 后端是 new-api：/v1 下是 OpenAI 兼容接口，用控制台「API Key」页
// 生成的 sk-… 令牌鉴权。插件做四件事：
//   - config：声明 provider（默认走 chat completions）
//   - auth：保存 API Key（magpie 原样存储，使用时再规范化）
//   - auth.usage：用 new-api 的 OpenAI 兼容账单接口算余额
//   - provider.models：按账号拉取可用模型

const PROVIDER = "anystarx"
const SITE = "https://console.anystarx.com"
const BASE = `${SITE}/v1`
const ICON = `${SITE}/brand/anystarx-logomark-primary.svg`
const TIMEOUT_MS = 15_000

// new-api 对 unlimited_quota 的令牌，hard_limit_usd 固定返回 1 亿
const UNLIMITED_USD = 100_000_000

// normalizeKey 去掉空白；用户只粘贴了打码前缀后面那段时补上 sk-
function normalizeKey(raw) {
  const key = String(raw ?? "").trim()
  if (!key) return ""
  return key.startsWith("sk-") ? key : `sk-${key}`
}

async function call(path, key, { signal } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) {
    let message = text.slice(0, 300)
    try {
      message = JSON.parse(text)?.error?.message ?? message
    } catch {}
    throw Object.assign(new Error(`AnyStarX ${path}: ${res.status} ${message}`), { status: res.status })
  }
  return JSON.parse(text)
}

// ---- 模型 ----------------------------------------------------------------------

// npmOf 按 new-api 在 /v1/models 里给出的 supported_endpoint_types 选 SDK：
// 能走 chat completions 就走（最通用）；只支持 Anthropic Messages 的走
// anthropic；只支持 Responses 的走 openai。没有这个字段的旧版本一律 chat completions。
function npmOf(types) {
  const t = Array.isArray(types) ? types : []
  if (!t.length || t.includes("openai")) return "@ai-sdk/openai-compatible"
  if (t.includes("anthropic")) return "@ai-sdk/anthropic"
  if (t.includes("openai-response")) return "@ai-sdk/openai"
  return "@ai-sdk/openai-compatible"
}

// 对话用得上的接口类型；new-api 还会给 image-generation、embeddings 等
const CHAT_TYPES = ["openai", "anthropic", "openai-response", "gemini"]

// 名字里带这些词的是生图 / 向量 / 语音等模型，不能用来对话
const NOT_CHAT = /(^|[-_.])(image|embedding|tts|whisper|dall-e|rerank|moderation)([-_.]|$)/i

// isChat 判断一个模型能不能出现在对话的模型列表里：
// 带 * 的是渠道配置里的通配名，不能直接调用；给了接口类型就按类型判断；
// 名字再兜一次底（站点可能把生图模型也标成 openai）
function isChat(m) {
  if (m.id.includes("*")) return false
  const t = m.supported_endpoint_types
  if (Array.isArray(t) && t.length && !t.some((x) => CHAT_TYPES.includes(x))) return false
  return !NOT_CHAT.test(m.id)
}

// toModels 把 /v1/models 的返回合并进 magpie 已有的模型表：已有字段（models.dev
// 或用户配置给的 limit、cost 等）保留，只补 id / name / api
function toModels(list, have = {}) {
  const out = {}
  for (const m of list?.data ?? []) {
    const id = m?.id
    if (typeof id !== "string" || !id || !isChat(m)) continue
    const was = have[id] ?? {}
    out[id] = {
      ...was,
      id,
      providerID: PROVIDER,
      name: was.name ?? id,
      api: { ...(was.api ?? {}), id, url: BASE, npm: npmOf(m.supported_endpoint_types) },
    }
  }
  return out
}

// ---- 余额 ----------------------------------------------------------------------

// describeBalance 把 new-api 的两个账单接口换成 magpie 的 usage 结果。
//   sub：GET /v1/dashboard/billing/subscription → { hard_limit_usd, access_until, … }
//        hard_limit_usd = 剩余 + 已用（美元）；无限额度令牌固定为 1 亿
//   use：GET /v1/dashboard/billing/usage → { total_usage }（已用，单位：美分）
// 站点开了 DisplayTokenStatEnabled 时两者都是「这把令牌」的数，否则是整个账号的。
function describeBalance(sub, use) {
  const total = Number(sub?.hard_limit_usd ?? 0)
  const used = Number(use?.total_usage ?? 0) / 100
  if (total >= UNLIMITED_USD) return { plan: "无限额度", windows: [] }
  const left = Math.max(0, total - used)
  return {
    // 总要给 plan：不给（或给空串）时 magpie 会沿用上次读到的值，比如之前的「无限额度」
    plan: "按量付费",
    balance: `$${left.toFixed(2)}`,
    windows: [],
  }
}

async function usage(key) {
  const now = new Date()
  const day = (d) => d.toISOString().slice(0, 10)
  const start = day(new Date(now.getTime() - 100 * 86400_000))
  const end = day(new Date(now.getTime() + 86400_000))
  const [sub, use] = await Promise.all([
    call("/dashboard/billing/subscription", key),
    call(`/dashboard/billing/usage?start_date=${start}&end_date=${end}`, key),
  ])
  return describeBalance(sub, use)
}

// ---- 插件 ----------------------------------------------------------------------

export const AnyStarXPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "AnyStarX",
      npm: "@ai-sdk/openai-compatible",
      api: BASE,
      models: {},
    }
  },

  auth: {
    provider: PROVIDER,
    icon: ICON,
    methods: [
      {
        type: "api",
        label: "AnyStarX API Key（控制台 → API Key 页复制）",
        placeholder: "sk-…",
      },
    ],

    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      return {
        baseURL: BASE,
        apiKey: normalizeKey(auth.key),
        async fetch(input, init) {
          // 每次请求都重新取，账号切换或重新登录后不会用到旧 key
          const now = await getAuth()
          const headers = new Headers(init?.headers)
          headers.set("authorization", `Bearer ${normalizeKey(now?.key ?? auth.key)}`)
          headers.delete("x-api-key")
          return fetch(input, { ...init, headers })
        },
      }
    },

    async usage(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return { error: "未登录", windows: [], signIn: "expired" }
      try {
        return { ...(await usage(normalizeKey(auth.key))), signIn: "kept" }
      } catch (e) {
        if (e.status === 401) return { error: "API Key 无效或已被禁用", windows: [], signIn: "expired" }
        return { error: e.message, windows: [], signIn: "kept" }
      }
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      const have = provider?.models ?? {}
      if (auth?.type !== "api" || !auth.key) return have
      try {
        const out = toModels(await call("/models", normalizeKey(auth.key)), have)
        return Object.keys(out).length ? out : have
      } catch {
        // 拉取失败时保留原列表（magpie 文档要求）
        return have
      }
    },
  },
})

// 测试用
export const _internal = { normalizeKey, npmOf, isChat, toModels, describeBalance, UNLIMITED_USD }
