// Estimated Claude API pricing (USD per million tokens) used by the side panel.
//
// Source: Claude API skill reference bundled with Claude Code 2.1.316
//   ("Current Models (cached: 2026-10-06)", shared/models.md, shared/prompt-caching.md), checked 2026-11-02.
//   Cache write = 1.25x input (5-minute TTL) / 2x input (1-hour TTL).
//   Cache read  = 0.1x input unless the model lists its own rate (Opus 5.5 / Sonnet 5.5 $0.20, Fable 5.1 $0.25, Fable 5 $1).
// These are first-party API list prices; subscription (Pro/Max) usage is not billed this way,
// so the panel always labels the figure as an estimate.
//
// Edit the table below when prices change. `match` is tested against the model id (lower-cased);
// the FIRST matching row wins, so keep more specific ids above generic family rows.
// Fields: in, out, read (cache read); w5m / w1h default to 1.25x / 2x of `in` when omitted.
// `long` = optional higher tier when the prompt (input + cache) exceeds `over` tokens.
const PRICING_TABLE = [
  { name: 'Fable 5.1',   match: /fable-5-1|mythos-5-1/,       in: 10,  out: 50,  read: 0.25 },
  { name: 'Fable 5',     match: /fable-5|mythos-5|mythos/,    in: 10,  out: 50,  read: 1.0 },
  { name: 'Fable',       match: /fable/,                      in: 10,  out: 50,  read: 0.25 },
  { name: 'Opus 5.5',    match: /opus-5-5/,                   in: 4,   out: 20,  read: 0.2 },
  { name: 'Opus 5',      match: /opus-5/,                     in: 5,   out: 25,  read: 0.5 },
  { name: 'Opus 4.x',    match: /opus-4-[6-9]/,              in: 5,   out: 25,  read: 0.5 },
  { name: 'Opus',        match: /opus/,                       in: 4,   out: 20,  read: 0.2 },
  { name: 'Sonnet 5.5',  match: /sonnet-5-5/,                 in: 2,   out: 10,  read: 0.2 },
  { name: 'Sonnet 5',    match: /sonnet-5/,                   in: 2,   out: 10,  read: 0.2 },
  { name: 'Sonnet 4.x',  match: /sonnet-4/,                   in: 3,   out: 15,  read: 0.3 },
  { name: 'Sonnet',      match: /sonnet/,                     in: 2,   out: 10,  read: 0.2 },
  { name: 'Haiku 5.5',   match: /haiku-5-5/,                  in: 0.1, out: 0.5, read: 0.01,
    long: { over: 100000, in: 0.5, out: 2.5, read: 0.05 } },
  { name: 'Haiku 4.5',   match: /haiku-4-5/,                  in: 1,   out: 5,   read: 0.1 },
  { name: 'Haiku',       match: /haiku/,                      in: 0.1, out: 0.5, read: 0.01 },
];
// Used when the model id matches nothing above (unknown / future model): current default Opus.
const PRICING_FALLBACK = { name: 'Opus 5.5 (fallback)', in: 4, out: 20, read: 0.2 };

(function () {
  function rates(model) {
    const id = String(model || '').toLowerCase();
    return PRICING_TABLE.find((r) => r.match.test(id)) || PRICING_FALLBACK;
  }

  // usage = raw Anthropic usage object. Returns USD.
  function cost(model, usage) {
    if (!usage) return 0;
    let r = rates(model);
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    const read = usage.cache_read_input_tokens || 0;
    const create = usage.cache_creation_input_tokens || 0;
    const cc = usage.cache_creation || {};
    const w1hTok = Math.min(create, cc.ephemeral_1h_input_tokens || 0);
    const w5mTok = create - w1hTok;
    if (r.long && input + read + create > r.long.over) r = { ...r, ...r.long };
    const w5m = r.w5m ?? r.in * 1.25;
    const w1h = r.w1h ?? r.in * 2;
    return (input * r.in + output * r.out + read * r.read + w5mTok * w5m + w1hTok * w1h) / 1e6;
  }

  const api = { table: PRICING_TABLE, fallback: PRICING_FALLBACK, rates, cost };
  if (typeof window !== 'undefined') window.Pricing = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
