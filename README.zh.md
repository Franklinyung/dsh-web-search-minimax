# dsh-web-search-minimax

MiniMax 优先、DuckDuckGo 兜底的 DeepSeek Harness `ctx.web` 搜索后端。

DeepSeek Harness 的搜索 seam 一次只选一个 provider，原生没有备选链。这个 bundle 注册一个名为 `minimax-fallback` 的 provider，由它自己执行链路：

1. **MiniMax** —— 通过 MiniMax 的 Anthropic 兼容 Messages 接口调用原生 `web_search_20250305` 服务端工具（与官方 DeepSeek 搜索 provider 相同的协议）。每次搜索是一次完整模型轮次，解析的是 MiniMax 返回的结构化结果块，不抓正文。
2. **DuckDuckGo** —— 当 MiniMax 没有凭据、返回额度/鉴权/服务端错误（例如 `HTTP 402` / `HTTP 429`）、45 秒超时，或返回 0 条结果时，改走 DuckDuckGo 的公开 HTML 端点。DuckDuckGo 会用 `202` 反爬页限制突发请求，因此被拦时会按 0 秒、1.5 秒、5 秒退避并更换 UA 重试，全部失败才报错。

bundle 会把 `web.searchProvider` 固定为 `minimax-fallback`，不会误选其他已注册的 provider。该 provider 的 `available()` 恒为 true（DuckDuckGo 不需要 key），因此即使 MiniMax 没额度，`web_search` 仍会提供给模型。两边都失败时，错误信息会同时给出 MiniMax 与 DuckDuckGo 的具体原因。

在 DeepSeek Harness 0.2.2-rc.1、Node 24 上实测。

## 安装

```sh
dsh plugin --profile web add dsh-web-search-minimax
```

`dsh plugin add` 会把该 bundle 登记到 profile 的 `dsh.profile.bundles`；也可以在 Harness 界面里 Plugins → 添加 后安装。若界面提示需要重启，重启即可。

## 配置

默认值来自 bundle 自带的 `cordis.patch.yml`：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `minimaxBaseURL` | `https://api.minimaxi.com/anthropic/v1` | Anthropic 兼容端点前缀，自动追加 `/messages`；国际版账号请换成对应端点 |
| `minimaxModel` | `MiniMax-M3` | 辅助搜索轮次所用模型；必须接受 `thinking: {type: "disabled"}`，`MiniMax-M3.1-Flash` 不接受该参数，会一直回退 |
| `minimaxApiKeyEnv` | `MINIMAX_CN_API_KEY` | 凭据引用：先经 `ctx.credentials` 解析，再读启动进程的环境变量 |
| `minimaxApiKey` | 未设置 | 直接写死 key，仅本地试验用；正式使用建议用 `minimaxApiKeyEnv` |
| `minimaxApiVersion` | `2023-06-01` | `anthropic-version` 请求头 |
| `minimaxMaxTokens` | `4096` | 搜索轮次生成的 token 上限 |
| `minimaxMaxUses` | `5` | 单次请求最多使用几次原生 `web_search` |
| `minimaxTimeoutMs` | `45000` | MiniMax 侧超时时间，超时后回退 |
| `duckduckgoFallback` | `true` | 设为 `false` 则 MiniMax 失败时直接报错，不回退 |
| `duckduckgoTimeoutMs` | `20000` | DuckDuckGo 侧超时 |
| `duckduckgoEndpoint` | `https://html.duckduckgo.com/html/` | DuckDuckGo HTML 端点 |
| `duckduckgoRegion` | `wt-wt` | `kl` 地区参数 |

要覆盖默认值，在你 profile 自己的 `cordis.patch.yml` 里重述这一行（它在所有 bundle 层之后应用）：

```yaml
- id: web-search-minimax-fallback
  name: dsh-web-search-minimax
  config:
    minimaxBaseURL: https://api.minimax.io/anthropic/v1
    minimaxModel: MiniMax-M3
    minimaxApiKeyEnv: MINIMAX_API_KEY
    duckduckgoFallback: true
```

行级 `config` 是整体替换，需要用的键都要重述。

MiniMax key 的两种放法：写进 Harness 的凭据库（例如在 Models 页面添加一个 MiniMax provider，`apiKeyEnv` 填上表里的引用名），或在启动 `dsh` 的环境里导出同名环境变量。没有 MiniMax 凭据时会直接走 DuckDuckGo，不会报错中断。

## 行为说明

- 一次 MiniMax 搜索是一次完整模型轮次（有延迟和 token 成本）；DuckDuckGo 只是一次 HTML 请求。
- 结果统一归一化为 seam 的 `sources[]`（`url`、`title`、`snippet`、`publishedAt`），最终条数由 seam 按调用方的 `maxResults` 截断。
- 每次搜索都会写一条 log-only 会话事件 `web/minimax-fallback-search`，记录实际后端（`minimax`/`duckduckgo`）、端点、query，以及触发回退的原因，排查额度问题时很有用。
- 调用方取消（abort）不会被回退吞掉，按 `AbortError` 传播。
- DuckDuckGo 没有 key、也没有 SLA：短时间大量搜索时反爬页可能扛过重试，此时会报告两边都失败。想只看到 MiniMax 自己的错误，就把 `duckduckgoFallback` 设为 `false`。

## 已知限制

- **没有设置页**。官方 Plugins → Web search 页面编辑的是内置 DeepSeek provider，不是本插件；本插件按上面的 profile patch 键配置。
- **依赖 Anthropic Messages 协议面**。MiniMax 侧假定该端点提供 `web_search_20250305` 服务端工具；如果 MiniMax 改了这个能力，主路会开始回退到 DuckDuckGo。
- **依赖 DuckDuckGo 页面结构**。兜底解析的是 DuckDuckGo 的 HTML 结果页；对方改版时需要改插件代码，配置改不了。

## 开发

```sh
MINIMAX_KEY=... npm test
```

`test/search-backends.test.mjs` 覆盖 URL 还原、HTML 实体解码、响应映射、真实 DuckDuckGo 页面解析、两种回退触发、双后端失败、关闭回退、正常主路与取消传播。回退相关用例走本地 mock server，不需要外网；主路用例会真实请求 MiniMax。

## 卸载

在 Plugins 页已安装 bundle 里移除，或执行：

```sh
dsh plugin --profile web remove dsh-web-search-minimax
```

移除后固定 provider 消失，seam 回到基础组合里的搜索 provider。

## 许可证

MIT
