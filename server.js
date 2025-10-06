// AIVARA backend v2 — multi-provider (Bybit → OKX → Binance via proxy [opsional])
// Realtime rule-based signals + SSE, tanpa API key

import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
app.use(cors({ origin: '*', methods: ['GET'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// ====== ENV ======
const PORT = process.env.PORT || 3000;

// Simbol: gunakan format USDT perpetual standar, mis. BTCUSDT, ETHUSDT
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase());

// Timeframe default
const TIMEFRAME = (process.env.TIMEFRAME || '1m').toLowerCase();

// Interval engine (detik)
const ENGINE_INTERVAL = Math.max(10, parseInt(process.env.ENGINE_INTERVAL || '30', 10));

// Urutan provider (tanpa spasi), default Bybit → OKX. Bisa diubah via ENV.
const PROVIDERS = (process.env.PROVIDERS || 'BYBIT,OKX').split(',').map((x) => x.trim().toUpperCase());

// (Opsional) Proxy Cloudflare Worker untuk Binance, kalau nanti mau pakai BINANCE juga:
// PROXY_BASE=https://<your-worker>.workers.dev
const PROXY_BASE = (process.env.PROXY_BASE || '').replace(/\/+$/, '');

// ====== STATE ======
let SIGNALS = {
  updated_at: new Date().toISOString(),
  timeframe: TIMEFRAME,
  version: '2.0',
  provider_order: PROVIDERS,
  signals: [],
};

// ====== UTIL ======
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  const gains = [], losses = [];
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

// ====== INTERVAL MAPS ======
// Bybit intervals: 1,3,5,15,30,60,120,240,360,720,1440,10080,43200
const BYBIT_MAP = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': '1440' };
// OKX bars: 1m,3m,5m,15m,30m,1H,2H,4H,6H,12H,1D,...
const OKX_MAP = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H', '1d': '1D' };

// ====== PROVIDERS FETCHERS ======

// Normalize klines: [openTime(ms), open, high, low, close]
function ensureArray(x) { return Array.isArray(x) ? x : []; }

// --- BYBIT ---
async function fetchKlinesBybit(symbol = 'BTCUSDT', interval = '1m', limit = 200) {
  const i = BYBIT_MAP[interval] || BYBIT_MAP['1m'];
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${i}&limit=${Math.min(200, limit)}`;
  const { data } = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'AIVARA/2.0' }, responseType: 'json' });
  if (!data || !data.result || !Array.isArray(data.result.list)) throw new Error('bybit_bad_shape');
  // Bybit list biasanya newest→oldest, kita urutkan oldest→newest
  const rows = [...data.result.list].sort((a, b) => Number(a[0]) - Number(b[0]));
  // list item shape: [start(ms), open, high, low, close, volume, turnover]
  return rows.map(r => [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4])]);
}

// --- OKX ---
function toOkxInstId(symbol = 'BTCUSDT') {
  // BTCUSDT -> BTC-USDT-SWAP  (asumsi pasangan USDT perpetual)
  const base = symbol.replace('USDT', '');
  return `${base}-USDT-SWAP`;
}
async function fetchKlinesOkx(symbol = 'BTCUSDT', interval = '1m', limit = 200) {
  const bar = OKX_MAP[interval] || OKX_MAP['1m'];
  const instId = toOkxInstId(symbol);
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${Math.min(200, limit)}`;
  const { data } = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'AIVARA/2.0' }, responseType: 'json' });
  if (!data || !Array.isArray(data.data)) throw new Error('okx_bad_shape');
  // OKX data biasanya newest→oldest, urutkan oldest→newest
  const rows = [...data.data].sort((a, b) => Number(a[0]) - Number(b[0]));
  // row: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
  return rows.map(r => [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4])]);
}

// --- BINANCE via PROXY (opsional, kalau PROXY_BASE di-set) ---
async function fetchKlinesBinanceProxy(symbol = 'BTCUSDT', interval = '1m', limit = 200) {
  if (!PROXY_BASE) throw new Error('no_proxy_base');
  const url = `${PROXY_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${Math.min(200, limit)}`;
  const { data } = await axios.get(url, { timeout: 15000, responseType: 'json', headers: { 'User-Agent': 'AIVARA/2.0' } });
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('binance_bad_shape');
  // Binance klines: [openTime, open, high, low, close, ...]
  return data.map(r => [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4])]);
}

// Master fetcher with fallback order
async function getKlines(symbol = 'BTCUSDT', interval = TIMEFRAME, limit = 200, preferProvider) {
  const order = preferProvider ? [preferProvider.toUpperCase(), ...PROVIDERS.filter(p => p.toUpperCase() !== preferProvider.toUpperCase())] : [...PROVIDERS];
  // Tambahkan BINANCE jika PROXY_BASE tersedia dan belum ada di order
  if (PROXY_BASE && !order.includes('BINANCE')) order.push('BINANCE');

  let lastErr = null;
  for (const prov of order) {
    try {
      if (prov === 'BYBIT') return await fetchKlinesBybit(symbol, interval, limit);
      if (prov === 'OKX') return await fetchKlinesOkx(symbol, interval, limit);
      if (prov === 'BINANCE') return await fetchKlinesBinanceProxy(symbol, interval, limit);
    } catch (e) {
      lastErr = e;
      // backoff kecil supaya tidak spam
      await sleep(200 + Math.floor(Math.random() * 300));
    }
  }
  throw new Error(`all_providers_failed: ${lastErr?.message || 'unknown'}`);
}

// ====== SIGNAL BUILDER ======
function buildSignal(symbol, interval, klines) {
  if (!Array.isArray(klines) || !klines.length || !Array.isArray(klines[0])) {
    throw new Error(`klines_invalid_${symbol}`);
  }
  const closes = klines.map(r => +r[4]);
  const last = klines.at(-1);
  const close = +last[4];

  const e20 = ema(closes, 20).at(-1);
  const e50 = ema(closes, 50).at(-1);
  const rsi14 = rsi(closes, 14);
  const a14 = atr(klines, 14);

  let dir = null, why = [];
  if (close > e50 && e20 > e50 && rsi14 > 50) { dir = 'LONG'; why.push('Uptrend EMA20>EMA50', 'RSI>50'); }
  if (close < e50 && e20 < e50 && rsi14 < 50) { dir = 'SHORT'; why.push('Downtrend EMA20<EMA50', 'RSI<50'); }
  if (!dir) return { symbol, direction: 'FLAT', note: 'No setup', generated_at: new Date().toISOString() };

  let lo = dir === 'LONG' ? e20 - 0.5 * a14 : e20 + 0.5 * a14;
  let hi = dir === 'LONG' ? e20 + 0.2 * a14 : e20 - 0.2 * a14;
  if (lo > hi) { const t = lo; lo = hi; hi = t; }

  let sl, tp1, tp2, tp3;
  if (dir === 'LONG') {
    sl = Math.min(e50 - 0.5 * a14, lo - 0.8 * a14);
    tp1 = hi + 1.0 * a14; tp2 = hi + 1.6 * a14; tp3 = hi + 2.2 * a14;
  } else {
    sl = Math.max(e50 + 0.5 * a14, hi + 0.8 * a14);
    tp1 = lo - 1.0 * a14; tp2 = lo - 1.6 * a14; tp3 = lo - 2.2 * a14;
  }

  const mid = (lo + hi) / 2;
  const riskFrac = Math.abs(mid - sl) / mid;
  let lev = Math.max(1, Math.floor(0.01 / Math.max(1e-6, riskFrac))); // risk 1%/trade
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

// ====== ENGINE + SSE ======
const clients = new Set();
function broadcast(data) { for (const res of clients) { try { res.write(`data: ${data}\n\n`); } catch (_) {} } }

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
      version: '2.0',
      provider_order: PROVIDERS,
      signals: out,
    };
    broadcast(JSON.stringify({ type: 'signals', payload: SIGNALS }));
  } else {
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
    providers: PROVIDERS,
    version: SIGNALS.version,
  })
);

app.get('/api/signals', (req, res) => res.json(SIGNALS));

// Klines proxy + provider override (?provider=BYBIT|OKX|BINANCE)
app.get('/api/klines', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', interval = TIMEFRAME, limit = 500, provider } = req.query;
    const data = await getKlines(String(symbol).toUpperCase(), String(interval), Math.min(1500, Number(limit) || 500), provider);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'klines_failed', detail: e.message });
  }
});

// SSE realtime
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
