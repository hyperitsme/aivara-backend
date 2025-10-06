// server.js (PATCHED)
import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
app.use(cors({ origin: '*', methods: ['GET'] }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT').split(',').map(s=>s.trim().toUpperCase());
const TIMEFRAME = process.env.TIMEFRAME || '1m';
const ENGINE_INTERVAL = Math.max(10, parseInt(process.env.ENGINE_INTERVAL || '30',10));
const BASE = 'https://fapi1.binance.com';

let SIGNALS = { updated_at: new Date().toISOString(), timeframe: TIMEFRAME, version: '1.0', signals: [] };

async function getKlines(symbol, interval='1m', limit=200){
  const url = `${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const { data } = await axios.get(url, { 
    timeout: 12000, 
    headers: { 'User-Agent': 'AIVARA/1.0 (+https://aivara.app)' }
  });
  return data;
}
function ema(v,p){ const k=2/(p+1); const o=[]; let prev; for(let i=0;i<v.length;i++){const x=v[i]; prev=i? x*k+prev*(1-k):x; o.push(prev);} return o; }
function rsi(c,p=14){ const g=[],l=[]; for(let i=1;i<c.length;i++){const d=c[i]-c[i-1]; g.push(Math.max(0,d)); l.push(Math.max(0,-d));} const eg=ema(g,p).at(-1)||1e-6, el=ema(l,p).at(-1)||1e-6; const rs=eg/el; return 100-100/(1+rs); }
function atr(kl,p=14){ const trs=[]; for(let i=1;i<kl.length;i++){const h=+kl[i][2], lo=+kl[i][3], pc=+kl[i-1][4]; trs.push(Math.max(h-lo, Math.abs(h-pc), Math.abs(lo-pc)));} return ema(trs,p).at(-1); }

function buildSignal(symbol, interval, kl){
  const closes = kl.map(r=>+r[4]);
  const close = +kl.at(-1)[4];
  const e20 = ema(closes,20).at(-1);
  const e50 = ema(closes,50).at(-1);
  const rsi14 = rsi(closes,14);
  const a14 = atr(kl,14);

  let dir=null, why=[];
  if(close>e50 && e20>e50 && rsi14>50){ dir='LONG'; why=['Uptrend EMA20>EMA50','RSI>50']; }
  if(close<e50 && e20<e50 && rsi14<50){ dir='SHORT'; why=['Downtrend EMA20<EMA50','RSI<50']; }
  if(!dir){ return { symbol, direction:'FLAT', note:'No setup', generated_at:new Date().toISOString() }; }

  let lo = (dir==='LONG') ? e20 - 0.5*a14 : e20 + 0.5*a14;
  let hi = (dir==='LONG') ? e20 + 0.2*a14 : e20 - 0.2*a14;
  if(lo>hi){ const t=lo; lo=hi; hi=t; }

  let sl,tp1,tp2,tp3;
  if(dir==='LONG'){ sl=Math.min(e50-0.5*a14, lo-0.8*a14); tp1=hi+1.0*a14; tp2=hi+1.6*a14; tp3=hi+2.2*a14; }
  else { sl=Math.max(e50+0.5*a14, hi+0.8*a14); tp1=lo-1.0*a14; tp2=lo-1.6*a14; tp3=lo-2.2*a14; }

  const mid=(lo+hi)/2, riskFrac=Math.abs(mid-sl)/mid;
  let lev = Math.max(1, Math.floor(0.01/Math.max(1e-6,riskFrac)));  // 1% risk
  lev = Math.min(lev, 20);

  const trendGapPct = Math.abs(e20-e50)/close*100;
  let conf = 0.55 + Math.min(0.2, trendGapPct*0.05) + ((dir==='LONG'&&rsi14>55)||(dir==='SHORT'&&rsi14<45)?0.1:0);
  conf = Math.max(0.55, Math.min(conf, 0.95));

  return {
    symbol, direction:dir,
    entry_zone:[+lo.toFixed(2), +hi.toFixed(2)],
    tp:[+tp1.toFixed(2), +tp2.toFixed(2), +tp3.toFixed(2)],
    sl:+sl.toFixed(2), leverage:`${lev}x`, confidence:+conf.toFixed(2),
    why, generated_at:new Date().toISOString()
  };
}

// Engine: per-symbol try/catch, tidak mengosongkan signals bila error
async function runEngine(){
  const out = [];
  await Promise.allSettled(SYMBOLS.map(async sym=>{
    try{
      const kl = await getKlines(sym, TIMEFRAME, 200);
      out.push(buildSignal(sym, TIMEFRAME, kl));
    }catch(e){
      console.error('symbol fail', sym, e.message);
    }
  }));
  if(out.length>0){
    SIGNALS = { updated_at:new Date().toISOString(), timeframe:TIMEFRAME, version:'1.0', signals: out };
    broadcast(JSON.stringify({ type:'signals', payload: SIGNALS }));
  } else {
    // keep old signals; still ping SSE so frontend tahu engine hidup
    broadcast(JSON.stringify({ type:'heartbeat', at: Date.now() }));
  }
}
setInterval(runEngine, ENGINE_INTERVAL*1000);
runEngine();

// REST
app.get('/api/health',(req,res)=>res.json({ ok:true, symbols:SYMBOLS, timeframe:TIMEFRAME, updated_at:SIGNALS.updated_at, count:SIGNALS.signals.length }));
app.get('/api/signals',(req,res)=>res.json(SIGNALS));
app.get('/api/klines', async (req,res)=>{
  try{
    const { symbol='BTCUSDT', interval=TIMEFRAME, limit=500 } = req.query;
    const data = await getKlines(String(symbol).toUpperCase(), String(interval), Math.min(1500, Number(limit)||500));
    res.json(data);
  }catch(e){ res.status(502).json({ error:'binance_proxy_failed', detail:e.message }); }
});

// SSE
const clients = new Set();
function broadcast(data){ for(const r of clients){ try{ r.write(`data: ${data}\n\n`); }catch(_){}} }
app.get('/api/stream',(req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders && res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type:'hello', now: Date.now() })}\n\n`);
  clients.add(res);
  req.on('close',()=>clients.delete(res));
});

app.listen(PORT, ()=>console.log('AIVARA backend on', PORT));
