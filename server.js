import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT').split(',').map(s=>s.trim().toUpperCase());
const TIMEFRAME = process.env.TIMEFRAME || '1m';
const ENGINE_INTERVAL = Math.max(10, parseInt(process.env.ENGINE_INTERVAL || '30',10)); // seconds
const BASE = 'https://fapi.binance.com';

// In-memory store
let SIGNALS = { updated_at: new Date().toISOString(), timeframe: TIMEFRAME, version: '1.0', signals: [] };

// --- Helpers ---
async function getKlines(symbol, interval='1m', limit=200){
  const url = `${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const { data } = await axios.get(url, { timeout: 12000 });
  return data; // array
}
function ema(values, period){
  const k = 2/(period+1); const out=[]; let prev;
  for(let i=0;i<values.length;i++){ const v = values[i]; prev = (i===0)? v : (v*k + prev*(1-k)); out.push(prev); }
  return out;
}
function rsi(closes, period=14){
  const gains=[]; const losses=[];
  for(let i=1;i<closes.length;i++){
    const d = closes[i]-closes[i-1];
    gains.push(Math.max(0,d)); losses.push(Math.max(0,-d));
  }
  const eg = ema(gains,period).at(-1) || 0.000001;
  const el = ema(losses,period).at(-1) || 0.000001;
  const rs = eg/el;
  return 100 - 100/(1+rs);
}
function atr(klines, period=14){
  const trs=[];
  for(let i=1;i<klines.length;i++){
    const h = +klines[i][2], l = +klines[i][3], pc = +klines[i-1][4];
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  return ema(trs,period).at(-1);
}

// --- Rule-based signal ---
function buildSignal(symbol, interval, klines){
  const closes = klines.map(r=>+r[4]);
  const last = klines.at(-1);
  const close = +last[4];
  const e20 = ema(closes,20).at(-1);
  const e50 = ema(closes,50).at(-1);
  const rsi14 = rsi(closes,14);
  const atr14 = atr(klines,14);

  let dir = null; const why=[];
  if(close>e50 && e20>e50 && rsi14>50){ dir='LONG'; why.push('Uptrend EMA20>EMA50','RSI>50'); }
  if(close<e50 && e20<e50 && rsi14<50){ dir='SHORT'; why.push('Downtrend EMA20<EMA50','RSI<50'); }
  if(!dir){
    return { symbol, direction:'FLAT', note:'No setup', generated_at: new Date().toISOString() };
  }
  let entryLow = dir==='LONG' ? e20 - 0.5*atr14 : e20 + 0.5*atr14;
  let entryHigh= dir==='LONG' ? e20 + 0.2*atr14 : e20 - 0.2*atr14;
  if(entryLow>entryHigh){ const t=entryLow; entryLow=entryHigh; entryHigh=t; }

  let sl,tp1,tp2,tp3;
  if(dir==='LONG'){
    sl = Math.min(e50 - 0.5*atr14, entryLow - 0.8*atr14);
    tp1 = entryHigh + 1.0*atr14; tp2 = entryHigh + 1.6*atr14; tp3 = entryHigh + 2.2*atr14;
  }else{
    sl = Math.max(e50 + 0.5*atr14, entryHigh + 0.8*atr14);
    tp1 = entryLow - 1.0*atr14; tp2 = entryLow - 1.6*atr14; tp3 = entryLow - 2.2*atr14;
  }
  const entryMid = (entryLow+entryHigh)/2;
  const riskFrac = Math.abs(entryMid - sl)/entryMid;
  let lev = Math.max(1, Math.floor(0.01/Math.max(1e-6,riskFrac))); // 1% risk rule
  lev = Math.min(lev, 20);

  // confidence heuristic
  const trendGapPct = Math.abs(e20-e50)/close*100;
  let conf = 0.55 + Math.min(0.2, trendGapPct*0.05);
  conf += (dir==='LONG' && rsi14>55) || (dir==='SHORT' && rsi14<45) ? 0.1 : 0;
  conf = Math.max(0.55, Math.min(conf, 0.95));

  return {
    symbol, direction: dir,
    entry_zone: [Number(entryLow.toFixed(2)), Number(entryHigh.toFixed(2))],
    tp: [Number(tp1.toFixed(2)), Number(tp2.toFixed(2)), Number(tp3.toFixed(2))],
    sl: Number(sl.toFixed(2)),
    leverage: `${lev}x`, confidence: Number(conf.toFixed(2)),
    why, generated_at: new Date().toISOString()
  };
}

// --- Engine loop ---
async function runEngine(){
  try{
    const out = [];
    for(const sym of SYMBOLS){
      const kl = await getKlines(sym, TIMEFRAME, 200);
      out.push(buildSignal(sym, TIMEFRAME, kl));
    }
    SIGNALS = { updated_at: new Date().toISOString(), timeframe: TIMEFRAME, version:'1.0', signals: out };
    // notify SSE clients
    broadcast(JSON.stringify({ type:'signals', payload: SIGNALS }));
  }catch(err){
    console.error('engine error', err.message);
  }
}
setInterval(runEngine, ENGINE_INTERVAL*1000);
runEngine();

// --- REST endpoints ---
app.get('/api/health', (req,res)=> res.json({ ok:true, symbols:SYMBOLS, timeframe: TIMEFRAME, updated_at: SIGNALS.updated_at }));
app.get('/api/signals', (req,res)=> res.json(SIGNALS));
app.get('/api/klines', async (req,res)=>{
  const { symbol='BTCUSDT', interval=TIMEFRAME, limit=500 } = req.query;
  try{
    const data = await getKlines(String(symbol).toUpperCase(), String(interval), Math.min(1500, Number(limit)||500));
    res.json(data);
  }catch(e){
    res.status(502).json({ error:'binance_proxy_failed', detail: e.message });
  }
});

// --- SSE for realtime signals (and optional price pings) ---
const clients = new Set();
function broadcast(data){
  for(const res of clients){
    try{ res.write(`data: ${data}\n\n`); }catch(_){}
  }
}
app.get('/api/stream', (req,res)=>{
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type:'hello', now: Date.now() })}\n\n`);
  clients.add(res);
  req.on('close', ()=> clients.delete(res));
});

app.listen(PORT, ()=> console.log('AIVARA backend on', PORT));
