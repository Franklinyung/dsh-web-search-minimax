# dsh-web-search-minimax

MiniMax-first web search for the DeepSeek Harness `ctx.web` seam, with DuckDuckGo as a fallback.

DeepSeek Harness selects one search provider at a time and has no built-in fallback chain. This bundle registers a single provider, `minimax-fallback`, that runs the chain itself:

1. **MiniMax** — the native `web_search_20250305` server tool over MiniMax's Anthropic-compatible Messages endpoint (the same wire format the shipped DeepSeek search provider speaks). Each search is one model turn, so it returns MiniMax's own result blocks, never scraped prose.
2. **DuckDuckGo** — its public HTML endpoint, when MiniMax has no credential, reports a quota/auth/server error (for example `HTTP 402` / `HTTP 429`), times out after 45 seconds, or returns zero results. DuckDuckGo rate-limits bursts with a `202` anti-bot page, so a blocked attempt is retried at 0 s, 1.5 s and 5 s with a different user agent before the fallback reports failure.

The provider is pinned by `web.searchProvider: minimax-fallback`, so another registered provider is never selected by accident. It needs no credential to be considered available: DuckDuckGo works without a key, so `web_search` stays offered to the agent even when MiniMax is out of quota. A search that fails on both backends reports one error naming both causes.

Tested against DeepSeek Harness 0.2.2-rc.1 on Node 24.

## Install

```sh
dsh plugin --profile web add dsh-web-search-minimax
```

Or install it from the Harness UI: **Plugins → Add** (or a plugin market) and search for `dsh-web-search-minimax`. The bundle's patch inserts the provider row and pins it.

Restart the Harness if your client asks you to; the provider is active once the row shows as enabled.

## Configure

The defaults come from the bundle's own `cordis.patch.yml`:

| Key | Default | Meaning |
| --- | --- | --- |
| `minimaxBaseURL` | `https://api.minimaxi.com/anthropic/v1` | Anthropic-compatible endpoint base; `/messages` is appended. Use MiniMax's international endpoint if your account is not on the CN platform. |
| `minimaxModel` | `MiniMax-M3` | Model used for the auxiliary search turn. It must accept `thinking: {type: "disabled"}`; `MiniMax-M3.1-Flash` rejects that and will always fall back. |
| `minimaxApiKeyEnv` | `MINIMAX_CN_API_KEY` | Credential reference. Resolved through `ctx.credentials` first, then the launching environment. |
| `minimaxApiKey` | unset | Literal key for local experiments; prefer `minimaxApiKeyEnv` so no secret enters configuration. |
| `minimaxApiVersion` | `2023-06-01` | `anthropic-version` header. |
| `minimaxMaxTokens` | `4096` | Upper bound on generated tokens for the search turn. |
| `minimaxMaxUses` | `5` | Native `web_search` server-tool uses per request. |
| `minimaxTimeoutMs` | `45000` | MiniMax leg timeout before falling back. |
| `duckduckgoFallback` | `true` | Set `false` to fail on MiniMax errors instead of falling back. |
| `duckduckgoTimeoutMs` | `20000` | DuckDuckGo leg timeout. |
| `duckduckgoEndpoint` | `https://html.duckduckgo.com/html/` | DuckDuckGo HTML endpoint. |
| `duckduckgoRegion` | `wt-wt` | `kl` parameter (region). |

Override any key by restating the row in your profile's own `cordis.patch.yml`, which is applied after every bundle layer:

```yaml
- id: web-search-minimax-fallback
  name: dsh-web-search-minimax
  config:
    minimaxBaseURL: https://api.minimax.io/anthropic/v1
    minimaxModel: MiniMax-M3
    minimaxApiKeyEnv: MINIMAX_API_KEY
    duckduckgoFallback: true
```

A row-level `config` is replaced wholesale, so restate every key you need.

Store the key in the Harness credential store (for example through the Models page when adding a MiniMax provider with that `apiKeyEnv` value), or export it in the environment that launches `dsh`. A search that finds no MiniMax credential skips straight to DuckDuckGo instead of failing.

## Behavior notes

- One MiniMax search is a full model turn (latency and tokens); DuckDuckGo is a plain HTML request.
- Results are normalized to the seam's `sources[]` (`url`, `title`, `snippet`, `publishedAt`); the seam enforces the caller's `maxResults`.
- Every search appends a log-only session event `web/minimax-fallback-search` recording the backend (`minimax` or `duckduckgo`), endpoint, query, and the fallback reason when one fired. It is useful when diagnosing quota problems.
- The provider never throws on a caller abort; cancellation propagates as `AbortError`.
- DuckDuckGo has no API key and no SLA: under bursty use its anti-bot page can outlast the retries, and the search reports both backend failures. Set `duckduckgoFallback: false` if you would rather see MiniMax's own error alone.

## Limitations

- **No settings page.** The shipped Plugins → Web search page edits the built-in DeepSeek provider, not this one; configure this plugin through the profile patch keys above.
- **Tied to the Anthropic Messages wire format.** The MiniMax leg assumes its endpoint serves the `web_search_20250305` server tool. If MiniMax changes that surface, the primary leg starts falling back to DuckDuckGo.
- **DuckDuckGo markup.** The fallback parses DuckDuckGo's HTML result page; a markup change on their side is a plugin bug to fix, not a config problem.

## Development

```sh
MINIMAX_KEY=... npm test
```

`test/search-backends.test.mjs` covers URL unwrapping, entity decoding, response mapping, live DuckDuckGo parsing, both fallback triggers, the combined failure, the disabled fallback, the healthy primary path, and abort propagation. Fallback tests use a local mock server, so they run without network access; the primary-path test makes a real MiniMax request.

## Uninstall

Remove the bundle from your profile (Plugins page → installed bundles → remove, or `dsh plugin --profile web remove dsh-web-search-minimax`). The pinned provider disappears and the seam falls back to whatever search provider your base composition pins.

## License

MIT
