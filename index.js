/**
 * MiniMax-first web search with a DuckDuckGo fallback.
 *
 * DSH's `ctx.web` seam selects exactly one search provider and has no built-in
 * fallback chain, so this plugin registers a single provider that runs the
 * chain itself:
 *
 *   1. MiniMax through its Anthropic-compatible Messages endpoint and the
 *      native `web_search_20250305` server tool (the same wire format the
 *      shipped DeepSeek provider speaks).
 *   2. DuckDuckGo through its HTML endpoint when MiniMax has no credential,
 *      answers with a quota/auth/server error, times out, or returns no
 *      results.
 *
 * The provider is pinned by `web.searchProvider: minimax-fallback` in this
 * bundle's patch. `available()` is always true because the DuckDuckGo leg
 * needs no credential, so the seam never withholds web search from a request.
 *
 * Only Node built-ins (global fetch, AbortSignal) are used; the plugin imports
 * nothing from the harness so a linked workspace package needs no dependencies.
 *
 * @module dsh-web-search-minimax
 */

/** Search provider id this plugin registers on `ctx.web`. */
export const MINIMAX_FALLBACK_PROVIDER_ID = 'minimax-fallback'

/** Log-only session event recording which backend served one search. */
export const SEARCH_BACKEND_EVENT = 'web/minimax-fallback-search'

const USER_AGENT = 'deepseek-harness/web-search-minimax'

const DEFAULTS = {
  baseURL: 'https://api.minimaxi.com/anthropic/v1',
  model: 'MiniMax-M3',
  apiKeyEnv: 'MINIMAX_CN_API_KEY',
  apiVersion: '2023-06-01',
  maxTokens: 4096,
  maxUses: 5,
  minimaxTimeoutMs: 45_000,
  duckduckgoEndpoint: 'https://html.duckduckgo.com/html/',
  duckduckgoRegion: 'wt-wt',
  duckduckgoTimeoutMs: 20_000,
  duckduckgoAcceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
  duckduckgoUserAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  duckduckgoRetryUserAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
}

/** True for a positive integer config value; anything else falls back to a default. */
function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/** True for a non-empty string config value; anything else falls back to a default. */
function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

/** Read the current search settings from the plugin config. */
function resolveOptions(ctx, config) {
  const raw = config ?? {}
  const minimax = {
    baseURL: stringOr(raw.minimaxBaseURL, DEFAULTS.baseURL),
    model: stringOr(raw.minimaxModel, DEFAULTS.model),
    apiKeyEnv: stringOr(raw.minimaxApiKeyEnv, DEFAULTS.apiKeyEnv),
    apiKey: stringOr(raw.minimaxApiKey, undefined),
    apiVersion: stringOr(raw.minimaxApiVersion, DEFAULTS.apiVersion),
    maxTokens: positiveInt(raw.minimaxMaxTokens, DEFAULTS.maxTokens),
    maxUses: positiveInt(raw.minimaxMaxUses, DEFAULTS.maxUses),
    timeoutMs: positiveInt(raw.minimaxTimeoutMs, DEFAULTS.minimaxTimeoutMs),
  }
  const duckduckgo = {
    enabled: raw.duckduckgoFallback !== false,
    endpoint: stringOr(raw.duckduckgoEndpoint, DEFAULTS.duckduckgoEndpoint),
    region: stringOr(raw.duckduckgoRegion, DEFAULTS.duckduckgoRegion),
    timeoutMs: positiveInt(raw.duckduckgoTimeoutMs, DEFAULTS.duckduckgoTimeoutMs),
    acceptLanguage: stringOr(raw.duckduckgoAcceptLanguage, DEFAULTS.duckduckgoAcceptLanguage),
    userAgent: stringOr(raw.duckduckgoUserAgent, DEFAULTS.duckduckgoUserAgent),
    retryUserAgent: stringOr(raw.duckduckgoRetryUserAgent, DEFAULTS.duckduckgoRetryUserAgent),
  }
  return {
    minimax,
    duckduckgo,
    /**
     * Resolve the MiniMax key for one search: a literal config key, then the
     * credential store reference, then the launching environment.
     */
    resolveMiniMaxKey: async () => {
      if (minimax.apiKey !== undefined) return minimax.apiKey
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        try {
          const resolved = await credentials.resolve(minimax.apiKeyEnv)
          const value = resolved?.value
          if (typeof value === 'string' && value.length > 0) return value
        } catch (_unreadableStore) {
          // Fall through to the environment, exactly like the shipped provider.
        }
      }
      const ambient = process.env[minimax.apiKeyEnv]
      return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
    },
    /** Record the backend decision on the initiating session, when there is one. */
    record: (event) => {
      try {
        ctx.get('agents')?.currentInitiator()?.session.append(SEARCH_BACKEND_EVENT, event)
      } catch (_unrecorded) {
        // Log-only telemetry must never fail a search.
      }
    },
  }
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal) {
  if (signal?.aborted === true) {
    const error = new Error('web search aborted')
    error.name = 'AbortError'
    throw error
  }
}

/** One-line description of a failure for the combined error message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Map an Anthropic Messages response to the seam's normalized result: citeable
 * `web_search_result` items inside `web_search_tool_result` blocks, joined to
 * citation excerpts where the provider emits them.
 */
export function mapAnthropicSearchResponse(response) {
  const blocks = Array.isArray(response?.content) ? response.content : []
  const snippets = new Map()
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    for (const citation of block.citations ?? []) {
      if (typeof citation?.url !== 'string' || citation.url.length === 0) continue
      if (typeof citation.cited_text !== 'string' || citation.cited_text.length === 0) continue
      if (!snippets.has(citation.url)) snippets.set(citation.url, citation.cited_text)
    }
  }
  const seen = new Set()
  const sources = []
  for (const block of blocks) {
    if (block?.type !== 'web_search_tool_result') continue
    for (const item of block.content ?? []) {
      if (item?.type !== 'web_search_result') continue
      if (typeof item.url !== 'string' || item.url.length === 0 || seen.has(item.url)) continue
      seen.add(item.url)
      const snippet = snippets.get(item.url)
      sources.push({
        url: item.url,
        ...(typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {}),
        ...(typeof snippet === 'string' && snippet.length > 0 ? { snippet } : {}),
        ...(typeof item.page_age === 'string' && item.page_age.length > 0 ? { publishedAt: item.page_age } : {}),
      })
    }
  }
  return { sources, truncated: false }
}

/**
 * Run one MiniMax search through the Anthropic-compatible endpoint. Throws on
 * transport, HTTP, or shape failures so the caller can fall back.
 */
async function searchMiniMax(query, options, apiKey, signal) {
  throwIfSearchAborted(signal)
  const endpoint = `${options.baseURL.replace(/\/+$/u, '')}/messages`
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const body = {
    model: options.model,
    max_tokens: options.maxTokens,
    messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: options.maxUses }],
    thinking: { type: 'disabled' },
  }
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'anthropic-version': options.apiVersion,
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: combined,
    })
  } catch (error) {
    if (signal?.aborted === true) throwIfSearchAborted(signal)
    throw new Error(`MiniMax search request failed: ${messageOf(error)}`)
  }
  if (!response.ok) {
    let detail = ''
    try {
      const parsed = await response.json()
      detail = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message ?? ''
    } catch (_unreadableBody) {
      // Keep the status-only message.
    }
    throw new Error(`MiniMax API error (HTTP ${response.status})${detail ? `: ${detail}` : ''}`)
  }
  let parsed
  try {
    parsed = await response.json()
  } catch (error) {
    throw new Error(`MiniMax returned an unprocessable response body: ${messageOf(error)}`)
  }
  return mapAnthropicSearchResponse(parsed)
}

const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/giu
const CLASS_RE = /\bclass\s*=\s*"([^"]*)"/u
const HREF_RE = /\bhref\s*=\s*"([^"]*)"/u
const TAG_RE = /<[^>]*>/gu
const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp|#39));/giu

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
}

/** Decode the HTML entities DuckDuckGo writes into titles and snippets. */
export function decodeEntities(text) {
  return text.replace(ENTITY_RE, (match, decimal, hex, named) => {
    if (named !== undefined) return NAMED_ENTITIES[named.toLowerCase()] ?? match
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex, 16)
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return match
    try {
      return String.fromCodePoint(code)
    } catch (_invalidCodePoint) {
      return match
    }
  })
}

/** Strip tags and normalize whitespace in one HTML fragment. */
function cleanText(html) {
  return decodeEntities(html.replace(TAG_RE, ' ')).replace(/\s+/gu, ' ').trim()
}

/** Unwrap a DuckDuckGo redirect link and keep only http(s) destinations. */
export function normalizeResultUrl(href) {
  let candidate = href.trim()
  if (candidate.startsWith('//')) candidate = `https:${candidate}`
  let parsed
  try {
    parsed = new URL(candidate, 'https://duckduckgo.com/')
  } catch (_unparseable) {
    return href
  }
  if (/(^|\.)duckduckgo\.com$/iu.test(parsed.hostname) && parsed.pathname === '/l/') {
    const target = parsed.searchParams.get('uddg')
    if (target !== null && target.length > 0) {
      try {
        const unwrapped = new URL(target)
        return /^https?:$/iu.test(unwrapped.protocol) ? unwrapped.toString() : href
      } catch (_unparseableTarget) {
        return href
      }
    }
  }
  return /^https?:$/iu.test(parsed.protocol) ? parsed.toString() : href
}

/**
 * Read a DuckDuckGo HTML results page into sources. Titles come from
 * `result__a` anchors and snippets from the matching `result__snippet`.
 */
export function parseDuckDuckGoHtml(html) {
  const records = []
  let match
  ANCHOR_RE.lastIndex = 0
  while ((match = ANCHOR_RE.exec(html)) !== null) {
    const attrs = match[1]
    const classes = CLASS_RE.exec(attrs)?.[1].split(/\s+/u)
    if (classes === undefined) continue
    if (classes.includes('result__a')) {
      const href = HREF_RE.exec(attrs)?.[1]
      if (href === undefined) continue
      records.push({
        url: normalizeResultUrl(href),
        title: cleanText(match[2]),
        snippet: undefined,
      })
    } else if (classes.includes('result__snippet') && records.length > 0) {
      const text = cleanText(match[2])
      if (text.length > 0 && records[records.length - 1].snippet === undefined) {
        records[records.length - 1].snippet = text
      }
    }
  }
  const seen = new Set()
  const sources = []
  for (const record of records) {
    if (!/^https?:\/\//iu.test(record.url) || seen.has(record.url)) continue
    seen.add(record.url)
    sources.push({
      url: record.url,
      ...(record.title.length > 0 ? { title: record.title } : {}),
      ...(record.snippet !== undefined ? { snippet: record.snippet } : {}),
    })
  }
  return sources
}

/** Wait for a retry delay, rejecting early when the caller aborts. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('web search aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new Error('web search aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** One DuckDuckGo HTML request; throws on a bot check, transport, or HTTP failure. */
async function requestDuckDuckGoOnce(query, options, userAgent, signal) {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const endpoint = new URL(options.endpoint)
  endpoint.searchParams.set('q', query)
  if (endpoint.searchParams.get('kl') === null) endpoint.searchParams.set('kl', options.region)
  let response
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': options.acceptLanguage,
        'user-agent': userAgent,
      },
      signal: combined,
    })
  } catch (error) {
    if (signal?.aborted === true) throwIfSearchAborted(signal)
    throw new Error(`DuckDuckGo search request failed: ${messageOf(error)}`)
  }
  // DuckDuckGo answers a bot check with 202 and an "anomaly" page instead of results.
  if (response.status !== 200) throw new Error(`DuckDuckGo responded HTTP ${response.status}`)
  const html = await response.text()
  const sources = parseDuckDuckGoHtml(html)
  if (sources.length === 0) {
    throw new Error(
      /anomaly/iu.test(html)
        ? 'DuckDuckGo served its anti-bot page instead of results'
        : 'DuckDuckGo returned no parseable results',
    )
  }
  return { sources, truncated: false }
}

/**
 * Run one DuckDuckGo search. DuckDuckGo rate-limits bursts with a 202 anti-bot
 * page, so a blocked attempt is retried with a different user agent.
 */
async function searchDuckDuckGo(query, options, signal) {
  throwIfSearchAborted(signal)
  const attempts = [
    { delayMs: 0, userAgent: options.userAgent, acceptLanguage: options.acceptLanguage },
    { delayMs: 1_500, userAgent: options.retryUserAgent, acceptLanguage: 'en-US,en;q=0.9' },
    { delayMs: 5_000, userAgent: options.userAgent, acceptLanguage: 'en-US,en;q=0.9' },
  ]
  let lastError
  for (const attempt of attempts) {
    if (attempt.delayMs > 0) await sleep(attempt.delayMs, signal)
    try {
      return await requestDuckDuckGoOnce(
        query,
        { ...options, acceptLanguage: attempt.acceptLanguage },
        attempt.userAgent,
        signal,
      )
    } catch (error) {
      if (signal?.aborted === true) throwIfSearchAborted(signal)
      lastError = error
    }
  }
  throw lastError ?? new Error('DuckDuckGo search failed')
}

/** The provider registered on `ctx.web`. */
export class MiniMaxDuckDuckGoProvider {
  /** @param {() => ReturnType<typeof resolveOptions>} options */
  constructor(options) {
    this.options = options
    this.id = MINIMAX_FALLBACK_PROVIDER_ID
  }

  /** Always true: the DuckDuckGo leg needs no credential, so search stays offered. */
  available() {
    return true
  }

  /**
   * Run MiniMax first, then DuckDuckGo. A caller abort is rethrown; every other
   * failure of the primary leg is remembered and fallback is attempted.
   */
  async search(request, signal) {
    const options = this.options()
    throwIfSearchAborted(signal)
    const query = request.query
    let primaryFailure
    let apiKey
    try {
      apiKey = await options.resolveMiniMaxKey()
    } catch (error) {
      apiKey = undefined
      primaryFailure = new Error(`MiniMax credential resolution failed: ${messageOf(error)}`)
    }
    if (apiKey !== undefined) {
      try {
        const result = await searchMiniMax(query, options.minimax, apiKey, signal)
        if (result.sources.length > 0) {
          options.record({ backend: 'minimax', model: options.minimax.model, endpoint: options.minimax.baseURL, query })
          return result
        }
        primaryFailure = new Error('MiniMax returned no web search results')
      } catch (error) {
        if (signal?.aborted === true) throwIfSearchAborted(signal)
        primaryFailure = error
      }
    } else if (primaryFailure === undefined) {
      primaryFailure = new Error(`no MiniMax search credential ("${options.minimax.apiKeyEnv}")`)
    }

    if (!options.duckduckgo.enabled) {
      throw new Error(
        `MiniMax web search failed (${messageOf(primaryFailure)}) and the DuckDuckGo fallback is disabled in config`,
      )
    }
    options.record({
      backend: 'duckduckgo',
      endpoint: options.duckduckgo.endpoint,
      query,
      fallbackReason: messageOf(primaryFailure),
    })
    try {
      return await searchDuckDuckGo(query, options.duckduckgo, signal)
    } catch (error) {
      if (signal?.aborted === true) throwIfSearchAborted(signal)
      throw new Error(
        `web search failed on both backends. MiniMax: ${messageOf(primaryFailure)}. DuckDuckGo: ${messageOf(error)}`,
      )
    }
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-minimax-fallback'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Register the chained provider with `ctx.web`. */
export function apply(ctx, config) {
  const options = () => resolveOptions(ctx, config)
  const provider = new MiniMaxDuckDuckGoProvider(options)
  ctx.web.registerSearchProvider({
    id: provider.id,
    available: () => provider.available(),
    search: (request, signal) => provider.search(request, signal),
  })
}
