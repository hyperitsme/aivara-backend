// server.js — AIVARA backend (Node + Express + SSE)
// Realtime rule-based signals (tanpa OpenAI)

import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
app.use(cors({ origin: '*', methods: ['GET'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// ====== ENV ======
const PORT = process.env.PORT || 3000;
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase());
const TIMEFRAME = process.env.TIMEFRAME || '1m';
const ENGINE_INTERVAL = Math.max(10, parseInt(process.env.ENGINE_INTERVAL || '30', 10)); // seconds

// Futures API mirrors (binance sometimes geo-blocks)
const BASES = [
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
  'https://fapi3.binance.com',
];

let baseIdx = 0;
function nextBase() {
  baseIdx = (baseIdx + 1) % BASES.length;
  return BASES[baseIdx];
}

// ====== STATE ======
let SIGNALS = {
  updated_at: new Date().toISOString(),
  timeframe: TIMEFRAME,
  version: '1.0',
  signals: [],
};

// ====== HELPERS ======
async function getKlines(symbol, interval = '1m', limit = 200) {
  const maxRetry = 5;
  let lastErr = null;

  for (let i = 0; i < maxRetry; i++) {
    const base = nextBase();
    const url = `${base}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    try {
      // Ambil sebagai text dulu (kadang HTML error page), lalu parse manual
      const { data } = await axios.get(url, {
        timeout: 15000,
        responseType: 'text',
        headers: { 'User-Agent': 'AIVARA/1.0 (+https://aivara.app)' },
      });

      let payload = data;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          // tetap string, berarti bukan JSON valid
        }
      }

      // Validasi: harus Array of Array (klines)
      if (Array.isArray(payload) && payload.length && Array.isArray(payload[0])) {
        return payload;
      }

      const preview =
        typeof payload === 'string'
          ? payload.slice(0, 220)
          : JSON.stringify(payload).slice(0, 220);
      throw new Error(`Bad klines shape from ${base}: ${preview}`);
    } catch (err) {
      lastErr = err;
      // coba base lain
    }
  }
  throw new Error(`All klines bases failed: ${lastErr?.message || 'unknown'}`);
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = i ? v * k + prev * (1 - k) : v;
    out.push(prev);
  }
  return out;
}

function rsi(closes, period = 14) {
  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  const eg = ema(gains, period).at(-1) || 1e-6;
  const el = ema(losses, period).at(-1) || 1e-6;
  const rs = eg / el;
  return 100 - 100 / (1 + rs);
}

function atr(klines, period = 14) {
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = +klines[i][2];
    const l = +klines[i][3];
    const pc = +klines[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return ema(trs, period).at(-1);
}

// Guarded builder (pastikan klines valid)
function buildSignal(symbol, interval, klines) {
  if (!Array.isArray(klines) || !klines.length || !Array.isArray(klines[0])) {
    throw new Error(`klines invalid for ${symbol}`);
  }

  const closes = klines.map((r) => +r[4]);
  const last = klines.at(-1);
  const close = +last[4];

  const e20 = ema(closes, 20).at(-1);
  const e50 = ema(closes, 50).at(-1);
  const rsi14 = rsi(closes, 14);
  const a14 = atr(klines, 14);

  let dir = null;
  const why = [];
  if (close > e50 && e20 > e50 && rsi14 > 50) {
    dir = 'LONG';
    why.push('Uptrend EMA20>EMA50', 'RSI>50');
  }
  if (close < e50 && e20 < e50 && rsi14 < 50) {
    dir = 'SHORT';
    why.push('Downtrend EMA20<EMA50', 'RSI<50');
  }
  if (!dir) {
    return { symbol, direction: 'FLAT', note: 'No setup', generated_at: new Date().toISOString() };
  }

  let lo = dir === 'LONG' ? e20 - 0.5 * a14 : e20 + 0.5 * a14;
  let hi = dir === 'LONG' ? e20 + 0.2 * a14 : e20 - 0.2 * a14;
  if (lo > hi) {
    const t = lo;
    lo = hi;
    hi = t;
  }

  let sl, tp1, tp2, tp3;
  if (dir === 'LONG') {
    sl = Math.min(e50 - 0.5 * a14, lo - 0.8 * a14);
    tp1 = hi + 1.0 * a14;
    tp2 = hi + 1.6 * a14;
    tp3 = hi + 2.2 * a14;
  } else {
    sl = Math.max(e50 + 0.5 * a14, hi + 0.8 * a14);
    tp1 = lo - 1.0 * a14;
    tp2 = lo - 1.6 * a14;
    tp3 = lo - 2.2 * a14;
  }

  const mid = (lo + hi) / 2;
  const riskFrac = Math.abs(mid - sl) / mid;
  let lev = Math.max(1, Math.floor(0.01 / Math.max(1e-6, riskFrac))); // 1% risk
  lev = Math.min(lev, 20);

  const trendGapPct = Math.abs(e20 - e50) / close * 100;
  let conf = 0.55 + Math.min(0.2, trendGapPct * 0.05);
  conf += (dir === 'LONG' && rsi14 > 55) || (dir === 'SHORT' && rsi14 < 45) ? 0.1 : 0;
  conf = Math.max(0.55, Math.min(conf, 0.95));

  return {
    symbol,
    direction: dir,
    entry_zone: [Number(lo.toFixed(2)), Number(hi.toFixed(2))],
    tp: [Number(tp1.toFixed(2)), Number(tp2.toFixed(2)), Number(tp3.toFixed(2))],
    sl: Number(sl.toFixed(2)),
    leverage: `${lev}x`,
    confidence: Number(conf.toFixed(2)),
    why,
    generated_at: new Date().toISOString(),
  };
}

// ====== ENGINE LOOP ======
const clients = new Set();
function broadcast(data) {
  for (const res of clients) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch (_) {}
  }
}

async function runEngine() {
  const out = [];
  await Promise.allSettled(
    SYMBOLS.map(async (sym) => {
      try {
        const kl = await getKlines(sym, TIMEFRAME, 200);
        out.push(buildSignal(sym, TIMEFRAME, kl));
      } catch (e) {
        console.error('symbol fail', sym, e.message);
      }
    })
  );

  if (out.length) {
    SIGNALS = {
      updated_at: new Date().toISOString(),
      timeframe: TIMEFRAME,
      version: '1.0',
      signals: out,
    };
    broadcast(JSON.stringify({ type: 'signals', payload: SIGNALS }));
  } else {
    // jaga koneksi klien agar tahu engine masih hidup
    broadcast(JSON.stringify({ type: 'heartbeat', at: Date.now() }));
  }
}

setInterval(runEngine, ENGINE_INTERVAL * 1000);
runEngine();

// ====== ROUTES ======
app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    symbols: SYMBOLS,
    timeframe: TIMEFRAME,
    updated_at: SIGNALS.updated_at,
    count: SIGNALS.signals.length,
  })
);

app.get('/api/signals', (req, res) => res.json(SIGNALS));

app.get('/api/klines', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', interval = TIMEFRAME, limit = 500 } = req.query;
    const data = await getKlines(String(symbol).toUpperCase(), String(interval), Math.min(1500, Number(limit) || 500));
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'binance_proxy_failed', detail: e.message });
  }
});

// Server-Sent Events (realtime signals)
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'hello', now: Date.now() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ====== START ======
app.listen(PORT, () => console.log('AIVARA backend on', PORT));
