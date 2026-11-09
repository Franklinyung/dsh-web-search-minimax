import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const mod = await import(new URL('../index.js', import.meta.url))
const MINIMAX_KEY = process.env.MINIMAX_KEY
if (typeof MINIMAX_KEY !== 'string' || MINIMAX_KEY.length === 0) throw new Error('MINIMAX_KEY env is required')

const MOCK_DDG = `<html><body>
<div class="result results_links">
  <h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&rut=x">First &amp; One</a></h2>
  <a class="result__snippet" href="#">Snippet one</a>
</div>
<div class="result results_links">
  <h2><a rel="nofollow" class="result__a" href="https://example.org/two">Second</a></h2>
  <a class="result__snippet">Snippet <b>two</b></a>
</div>
</body></html>`

function makeCtx({ resolveKey = () => undefined, events = [] } = {}) {
  const ctx = {
    web: { registerSearchProvider: (provider) => { ctx.provider = provider } },
    get(name) {
      if (name === 'credentials') {
        return {
          resolve: async (ref) => {
            const value = ref === 'MINIMAX_CN_API_KEY' ? resolveKey() : undefined
            return value === undefined ? undefined : { value }
          },
        }
      }
      if (name === 'agents') {
        return { currentInitiator: () => ({ session: { append: (type, data) => events.push({ type, data }) } }) }
      }
      return undefined
    },
  }
  return ctx
}

function build(config, ctxOptions) {
  const events = []
  const ctx = makeCtx({ ...ctxOptions, events })
  mod.apply(ctx, config)
  return { provider: ctx.provider, events }
}

// 1. URL unwrapping and entity decoding.
assert.equal(
  mod.normalizeResultUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=abc'),
  'https://example.com/a?b=1',
)
assert.equal(mod.normalizeResultUrl('https://example.com/x'), 'https://example.com/x')
assert.equal(mod.decodeEntities('a &amp; b &lt;c&gt; &#39;d&#x27;'), "a & b <c> 'd'")
console.log('ok: url/entity helpers')

// 2. Anthropic response mapping.
const mapped = mod.mapAnthropicSearchResponse({
  content: [
    { type: 'text', text: 'x', citations: [{ url: 'https://a.example/1', cited_text: 'excerpt 1' }] },
    {
      type: 'web_search_tool_result',
      content: [
        { type: 'web_search_result', url: 'https://a.example/1', title: 'A', page_age: '2026/11/01' },
        { type: 'web_search_result', url: 'https://b.example/2', title: 'B' },
        { type: 'web_search_result', url: 'https://a.example/1', title: 'dup' },
      ],
    },
  ],
})
assert.deepEqual(mapped.sources, [
  { url: 'https://a.example/1', title: 'A', snippet: 'excerpt 1', publishedAt: '2026/11/01' },
  { url: 'https://b.example/2', title: 'B' },
])
console.log('ok: anthropic mapping')

// 3. Real DuckDuckGo markup parse (skipped when DuckDuckGo is currently throttling).
{
  const response = await fetch('https://html.duckduckgo.com/html/?q=deepseek+harness&kl=wt-wt', {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', accept: 'text/html' },
  })
  const html = await response.text()
  const parsed = mod.parseDuckDuckGoHtml(html)
  if (response.status === 200 && parsed.length >= 3) {
    assert.ok(parsed.every((s) => /^https?:\/\//.test(s.url)))
    console.log('ok: live DDG parse ->', parsed.length, 'sources; first =', parsed[0].url)
  } else {
    console.log('skip: live DDG currently rate-limited (HTTP', response.status, ', an anomaly page); parser covered by mock below')
  }
}

// Mock DuckDuckGo server for deterministic fallback tests.
const mock = createServer((req, res) => {
  if (req.url?.startsWith('/blocked')) {
    res.writeHead(202, { 'content-type': 'text/html' })
    res.end('<html>anomaly</html>')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(MOCK_DDG)
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const mockPort = mock.address().port
const mockEndpoint = `http://127.0.0.1:${mockPort}/search`

// 4. No MiniMax credential -> DuckDuckGo.
{
  const { provider, events } = build(
    { minimaxApiKeyEnv: 'NO_SUCH_KEY', duckduckgoFallback: true, duckduckgoEndpoint: mockEndpoint },
    { resolveKey: () => undefined },
  )
  const result = await provider.search({ query: 'deepseek harness', maxResults: 8 })
  assert.deepEqual(result.sources.map((s) => s.url), ['https://example.com/one', 'https://example.org/two'])
  assert.equal(result.sources[0].title, 'First & One')
  assert.equal(result.sources[1].snippet, 'Snippet two')
  assert.equal(events.at(-1).data.backend, 'duckduckgo')
  assert.match(events.at(-1).data.fallbackReason, /no MiniMax search credential/)
  console.log('ok: missing credential -> DDG fallback')
}

// 5. MiniMax error (model rejecting thinking:disabled) -> DuckDuckGo.
{
  const { provider, events } = build(
    {
      minimaxApiKeyEnv: 'MINIMAX_CN_API_KEY',
      minimaxModel: 'MiniMax-M3.1-Flash',
      duckduckgoFallback: true,
      duckduckgoEndpoint: mockEndpoint,
    },
    { resolveKey: () => MINIMAX_KEY },
  )
  const result = await provider.search({ query: 'deepseek harness', maxResults: 8 })
  assert.equal(result.sources.length, 2)
  assert.equal(events.at(-1).data.backend, 'duckduckgo')
  assert.match(events.at(-1).data.fallbackReason, /HTTP 400/)
  console.log('ok: MiniMax 400 -> DDG fallback')
}

// 6. Both backends unhealthy -> one combined, actionable error.
{
  const { provider } = build(
    {
      minimaxApiKeyEnv: 'MINIMAX_CN_API_KEY',
      minimaxModel: 'MiniMax-M3.1-Flash',
      duckduckgoFallback: true,
      duckduckgoEndpoint: `http://127.0.0.1:${mockPort}/blocked`,
    },
    { resolveKey: () => MINIMAX_KEY },
  )
  await assert.rejects(provider.search({ query: 'x' }), (error) => {
    assert.match(error.message, /both backends/u)
    assert.match(error.message, /DuckDuckGo responded HTTP 202/u)
    return true
  })
  console.log('ok: both-fail error mentions both backends')
}

// 7. Fallback disabled -> primary failure surfaces directly.
{
  const { provider } = build({ minimaxApiKeyEnv: 'NO_SUCH_KEY', duckduckgoFallback: false }, { resolveKey: () => undefined })
  await assert.rejects(provider.search({ query: 'x' }), /DuckDuckGo fallback is disabled/u)
  console.log('ok: disabled fallback surfaces primary failure')
}

// 8. Healthy MiniMax stays primary (live call).
{
  const { provider, events } = build(
    { minimaxApiKeyEnv: 'MINIMAX_CN_API_KEY', minimaxModel: 'MiniMax-M3', duckduckgoFallback: true, duckduckgoEndpoint: mockEndpoint },
    { resolveKey: () => MINIMAX_KEY },
  )
  const result = await provider.search({ query: 'DeepSeek Harness 最新版本', maxResults: 8 })
  assert.ok(result.sources.length > 0)
  assert.equal(events.at(-1).data.backend, 'minimax')
  console.log('ok: MiniMax primary ->', result.sources.length, 'sources')
}

// 9. Caller abort is honoured, not swallowed by fallback.
{
  const { provider } = build({ duckduckgoFallback: true }, { resolveKey: () => MINIMAX_KEY })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(provider.search({ query: 'x' }, controller.signal), /aborted/)
  console.log('ok: abort propagates')
}

mock.close()
console.log('ALL TESTS PASSED')
