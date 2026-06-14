'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { formatPrice, generateId, normalizeTickSize, roundToTick } from '@/lib/trading-utils';

const DEFAULT_RISK = process.env.NEXT_PUBLIC_DEFAULT_RISK ?? '47';
const DEFAULT_ATR = process.env.NEXT_PUBLIC_DEFAULT_ATR ?? '';
const DEFAULT_ENTRY_COUNT = process.env.NEXT_PUBLIC_DEFAULT_SUBSEQUENT_ENTRIES ?? '9';
const DEFAULT_INTERVAL = process.env.NEXT_PUBLIC_DEFAULT_INTERVAL ?? '0.5';
import SymbolSearch from '@/components/SymbolSearch';
import Totp from '@/components/Totp';
import DailyLossLimit from '@/components/DailyLossLimit';

interface TradeWorkspace {
  id: string;
  symbol: string;
  securityId: string;
  securityIdDirect: string;
  tickSize: number;
  segment: string;
  risk: string;
  atr: string;
  entry: string;
  interval: string;
  entriesCount: string;
  side: string;
  searchQuery: string;
}

type LevelRow = {
  label: string;
  trigger?: number | string;
  price?: number;
  qty?: number;
  total?: number;
  sl?: number;
  isAdd?: boolean;
};

export default function UnifiedCommandCenter() {
  const [auth, setAuth] = useState({ token: '' });
  const [trades, setTrades] = useState<TradeWorkspace[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [loading, setLoading] = useState(false);
  const isProcessing = useRef(false);

  useEffect(() => {
    // Get auth token from cookie
    const getCookie = (name: string) => {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) return parts.pop()?.split(';').shift() || '';
      return '';
    };
    const tokenFromCookie = getCookie('d_token');
    setAuth({ token: tokenFromCookie });
    const saved = JSON.parse(localStorage.getItem('active_workspaces') || '[]');
    const normalized = Array.isArray(saved)
      ? saved.map((item: unknown) => {
            const trade = item as Record<string, unknown>;
          return {
            id: typeof trade.id === 'string' ? trade.id : generateId(),
            symbol: typeof trade.symbol === 'string' ? trade.symbol : '',
            securityId: typeof trade.securityId === 'string' ? trade.securityId : '',
            securityIdDirect: typeof trade.securityIdDirect === 'string' ? trade.securityIdDirect : '',
            tickSize: typeof trade.tickSize === 'number' ? trade.tickSize : 5,
            segment: typeof trade.segment === 'string' ? trade.segment : 'NSE_EQ',
            risk: typeof trade.risk === 'string' ? trade.risk : DEFAULT_RISK,
            atr: typeof trade.atr === 'string' ? trade.atr : DEFAULT_ATR,
            entry: typeof trade.entry === 'string' ? trade.entry : '',
            interval: typeof trade.interval === 'string' ? trade.interval : DEFAULT_INTERVAL,
            entriesCount: typeof trade.entriesCount === 'number' ? String(trade.entriesCount) : typeof trade.entriesCount === 'string' ? trade.entriesCount : DEFAULT_ENTRY_COUNT,
            side: typeof trade.side === 'string' ? trade.side : 'SHORT',
            searchQuery: typeof trade.searchQuery === 'string' ? trade.searchQuery : ''
          };
        })
      : [];
    if (normalized.length > 0) setTrades(normalized);
    else {
      const newTrade = { id: generateId(), symbol: '', securityId: '', securityIdDirect: '', tickSize: 5, segment: 'NSE_EQ', risk: DEFAULT_RISK, atr: DEFAULT_ATR, entry: '', interval: DEFAULT_INTERVAL, entriesCount: DEFAULT_ENTRY_COUNT, side: 'SHORT', searchQuery: '' };
      setTrades([newTrade]);
    }
  }, []);

  useEffect(() => {
    if (trades.length > 0) localStorage.setItem('active_workspaces', JSON.stringify(trades));
    if (auth.token) {
      setCookie('d_token', auth.token, 18);
    }
  }, [trades, auth]);

  const current = trades[activeIndex] || { segment: 'NSE_EQ', risk: DEFAULT_RISK, atr: DEFAULT_ATR, entry: '', securityId: '', tickSize: 5, interval: DEFAULT_INTERVAL, entriesCount: DEFAULT_ENTRY_COUNT, side: 'SHORT' };

  const updateTrade = (updates: Partial<TradeWorkspace>) => {
    setTrades(prev => {
      const next = [...prev];
      next[activeIndex] = { ...next[activeIndex], ...updates };
      return next;
    });
  };

  const addNewTrade = () => {
    setTrades([...trades, { id: generateId(), symbol: '', securityId: '', securityIdDirect: '', tickSize: 5, segment: 'NSE_EQ', risk: DEFAULT_RISK, atr: DEFAULT_ATR, entry: '', interval: DEFAULT_INTERVAL, entriesCount: DEFAULT_ENTRY_COUNT, side: 'SHORT', searchQuery: '' }]);
    setActiveIndex(trades.length);
  };

  const setCookie = (key: string, value: string, duration?: number) => {
    if (!key || !value) {
      throw new Error('setCookie: key and value are required');
    }
    const durationHours = duration || 24;
    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + durationHours);
    document.cookie = `${key}=${value}; expires=${expiryDate.toUTCString()}; path=/`;
  };

  const copyAuthTokenToClipboard = async () => {
    if (!auth.token) return;
    try {
      await navigator.clipboard.writeText(auth.token);
      setCopyStatus('copied');
      window.setTimeout(() => setCopyStatus('idle'), 1500);
    } catch {
      setCopyStatus('error');
      window.setTimeout(() => setCopyStatus('idle'), 1500);
    }
  };

  const clearAuthCookie = () => {
    document.cookie = 'd_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/';
    setAuth({ token: '' });
  };

  // DASHBOARD MATH: Distance and Size
  const stats = useMemo(() => {
    const r = parseFloat(current.risk) || 47;
    const a = parseFloat(current.atr) || 0;
    if (!a) return { d15: 0, s15: 0, d20: 0, s20: 0 };
    
    const d15 = a * 1.5;
    const s15 = Math.floor(r / d15);
    const d20 = a * 2.0;
    const s20 = Math.floor(r / d20);
    
    return { d15, s15, d20, s20 };
  }, [current.risk, current.atr]);

  const calculateLevels = (multiplier: number): LevelRow[] => {
    const r = parseFloat(current.risk) || 47;
    const a = parseFloat(current.atr);
    const e = parseFloat(current.entry);
    const interval = parseFloat(current.interval) || 0.5;
    const tsRupee = normalizeTickSize(current.tickSize, current.segment);
    const side = (current.side || 'SHORT').toUpperCase();
    const isShort = side === 'SHORT';
    if (!a || !e) return [];

    const dist = a * multiplier;
    const initQty = Math.floor(r / dist);
    const addQty = Math.floor(initQty * 0.5);
    
    let shares = 0;
    let totalValue = 0;
    const rows: LevelRow[] = [];
    console.log(`Calculating levels (${side}) with Entry: ${e}, ATR: ${a}, Risk: ${r}, Interval: ${interval}, Multiplier: ${multiplier}, Initial Qty: ${initQty}, Add Qty: ${addQty} tickSize: ${tsRupee}₹`);
    
    // Helper function to calculate SL safely - keeps risk at or below limit
    const calculateSLSafe = (avgPrice: number, riskLimit: number, shares: number, tsRupee: number, isShortSide: boolean): number => {
      if (shares <= 0) return avgPrice;
      if (isShortSide) {
        // For SHORT: stop loss is above avg price
        const targetSL = avgPrice + (riskLimit / shares);
        const ticksAway = Math.floor((targetSL - avgPrice) / tsRupee);
        return avgPrice + ((ticksAway - 1) * tsRupee);
      } else {
        // For LONG: stop loss is below avg price
        const targetSL = avgPrice - (riskLimit / shares);
        const ticksAway = Math.floor((avgPrice - targetSL) / tsRupee);
        return avgPrice - ((ticksAway - 1) * tsRupee);
      }
    };
    
    // Initial position
    const startPrice = roundToTick(e, tsRupee);
    shares = initQty;
    totalValue = startPrice * initQty;
    let avgPrice = totalValue / shares;
    const startSL = calculateSLSafe(avgPrice, r, shares, tsRupee, isShort);
    rows.push({ label: 'START', trigger: formatPrice(e), price: startPrice, qty: initQty, sl: startSL, isAdd: false });

    for (let i = 1; i <= (Number(current.entriesCount) || 1); i++) {
      const trigger = roundToTick(isShort ? e - (i * interval) : e + (i * interval), tsRupee);
      const price = roundToTick(isShort ? trigger - tsRupee : trigger + tsRupee, tsRupee);
      shares += addQty;
      totalValue += price * addQty;
      avgPrice = totalValue / shares;
      const slPrice = calculateSLSafe(avgPrice, r, shares, tsRupee, isShort);
      rows.push({ label: `₹${formatPrice(trigger)}`, trigger: trigger, price: price, qty: addQty, total: shares, sl: slPrice, isAdd: true });
      const actualRisk = isShort ? (slPrice - avgPrice) * shares : (avgPrice - slPrice) * shares;
      console.log(`Level ${i}: Trigger: ${trigger}, Price: ${price}, Qty: ${addQty}, Total Shares: ${shares}, Avg Price: ${avgPrice.toFixed(2)}, SL: ${slPrice}, Actual Risk: ${actualRisk.toFixed(2)} (Limit: ${r})`);
    }
    return rows;
  };

  const deploy = async (orders: Array<Record<string, unknown>>) => {
    if (isProcessing.current || !current.securityId || !auth.token) return alert("Verify Token/ID First!");
    try {
      isProcessing.current = true;
      setLoading(true);
      // Attach transactionType based on per-tab side
      const mappedOrders = orders.map(o => {
        const trigger = typeof o.trigger === 'number' ? o.trigger : parseFloat(String(o.trigger || 0));
        return { ...o, trigger, transactionType: (current.side === 'LONG' ? 'BUY' : 'SELL') };
      });

      const res = await fetch('/api/place-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dhan-token': auth.token },
        body: JSON.stringify({ orders: mappedOrders, tradingSymbol: current.symbol, securityId: current.securityId, segment: current.segment })
      });
      const data = await res.json();
      alert(`SUCCESS: ${data.count} Orders Live.`);
    } finally {
      isProcessing.current = false;
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-brand-bg/20 p-2 text-brand-text selection:bg-brand-accent selection:text-brand-bg font-sans antialiased">

      {/* HEADER NAVIGATION */}
      <header className="sticky top-0 z-50 bg-brand-bg/80 backdrop-blur-md border-b border-brand-card/40 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="font-mono text-xl font-bold tracking-tight hidden md:block">
              CANDLES<span className="text-brand-accent">BEFORE</span>CUBICLES
            </span>
            <span className="font-mono text-xl  tracking-tight">
              TRADE<span className="text-brand-accent">ASSISTANT</span>
            </span>
          </div>
          <nav className="hidden md:flex items-center space-x-8 text-sm font-medium tracking-wide">
            <a href="#ecosystem" className="hover:text-brand-accent transition-colors">Ecosystem</a>
            <a href="#philosophy" className="hover:text-brand-accent transition-colors">Philosophy</a>
            <a href="#journey" className="hover:text-brand-accent transition-colors">The Shift</a>
            <a href="https://youtube.com/@CandlesBeforeCubicles" target="_blank" rel="noopener noreferrer" className="hover:text-brand-accent transition-colors">YouTube</a>
          </nav>
        </div>
      </header>
      
      {/* Totp Login - Collapsible */}
      {!auth.token && <Totp setAuth={setAuth} />}

      {/* AUTH */}
      <div className="bg-brand-card p-4 rounded-2xl border border-[#30363d] mb-4 shadow-xl relative">
        <div className="flex items-center gap-3">
          <input type="password" placeholder="Dhan Access Token" value={auth.token} className="flex-1 bg-black border border-[#30363d] p-4 rounded-xl text-xs text-center font-mono outline-none focus:border-[#2f81f7]" onChange={e => setAuth({ token: e.target.value })} />
          {auth.token && (
            <button 
              onClick={clearAuthCookie}
              className="px-3 py-2 bg-red-600/20 hover:bg-red-600/40 border border-red-600/40 rounded-lg text-red-400 font-bold text-xs transition-colors"
              title="Clear auth token"
            >
              ✕
            </button>
          )}
          {auth.token && (
            <button
              onClick={copyAuthTokenToClipboard}
              className="px-3 py-2 bg-[#2f81f7]/20 hover:bg-[#2f81f7]/40 border border-[#2f81f7]/40 rounded-lg text-[#2f81f7] font-bold text-xs transition-colors"
              title="Copy auth token"
            >
              {copyStatus === 'copied' ? 'Copied' : copyStatus === 'error' ? 'Error' : 'Copy'}
            </button>
          )}
        </div>
      </div>

      {/* MASKED CONTENT - Only visible when authenticated */}
      {!auth.token && (
        <div className="bg-[#0d1117] p-6 rounded-2xl border border-[#30363d] mb-4 text-center text-[#8b949e]">
          <span className="text-sm">⚠️ Please authenticate with TOTP to continue</span>
        </div>
      )}

      {auth.token && <DailyLossLimit token={auth.token} />}

      {/* TABS */}
      {auth.token && (
      <div className="flex items-center space-x-2 overflow-x-auto pb-4 mb-4 no-scrollbar border-b border-[#30363d]">
        {trades.map((t, i) => (
          <button key={t.id} onClick={() => setActiveIndex(i)} className={`flex-shrink-0 px-5 py-2 rounded-xl text-xs font-bold transition-all border ${i === activeIndex ? 'bg-brand-accent/80 border-brand-accent/10 text-brand-bg shadow-lg shadow-blue-500/20' : 'bg-brand-card text-brand-text border-brand-accent/80 hover:bg-brand-accent/10 hover:border-brand-accent/20'}`}>
            {t.symbol || 'EMPTY'}
          </button>
        ))}
        <button onClick={addNewTrade} className="bg-brand-card px-4 py-1 rounded-xl text-brand-text font-black border border-brand-accent/80 hover:bg-brand-accent/10 hover:border-brand-accent/20">+</button>
      </div>
      )}

      {/* WORKSPACE */}
      {auth.token && (
      <div className="bg-brand-card p-5 rounded-3xl border border-[#30363d] mb-6 space-y-4 shadow-2xl">
        <div className="flex justify-between items-center">
            <span>
            <span className="text-[10px] text-brand-text font-black uppercase tracking-widest">ID:</span>
            <span className="text-[10px] text-brand-text uppercase tracking-widest"> {current.securityId || "---"}</span>
            </span>
            <select value={current.segment} onChange={e => updateTrade({ segment: e.target.value, symbol: '', securityId: '' })} className="bg-brand-bg border border-brand-bg/80 text-[10px] font-bold text-data-green p-1 rounded uppercase outline-none focus:border-data-green/40 focus:bg-brand-bg/80 transition-colors selection:bg-brand-accent selection:text-brand-bg hover:bg-brand-bg/80">
                <option value="NSE_EQ">NSE Cash</option>
                <option value="MCX_COMM">MCX Comm</option>
            </select>
                <div className="flex items-center space-x-2">
                  <button onClick={() => updateTrade({ side: 'SHORT' })} className={`px-3 py-1 rounded-lg text-[10px] font-black ${current.side === 'SHORT' ? 'bg-data-red text-brand-text' : 'bg-[#0d1117] text-[#8b949e] border border-[#30363d] hover:bg-data-red/40 hover:border-data-red/40 hover:text-brand-text'}`}>SHORT</button>
                  <button onClick={() => updateTrade({ side: 'LONG' })} className={`px-3 py-1 rounded-lg text-[10px] font-black ${current.side === 'LONG' ? 'bg-data-green text-brand-text' : 'bg-[#0d1117] text-[#8b949e] border border-[#30363d] hover:bg-data-green/40 hover:border-data-green/40 hover:text-brand-text'}`}>LONG</button>
                </div>
        </div>

        <SymbolSearch 
          segment={current.segment} 
          searchQuery={current.searchQuery} 
          onSearchChange={(query: string) => updateTrade({ searchQuery: query })} 
          onSelect={(sym, id, ts) => updateTrade({ symbol: sym, securityId: id, tickSize: ts, searchQuery: sym })}
          securityIdDirect={current.securityIdDirect}
          onSecurityIdDirectChange={(id: string) => {
            if (id.length > 0) {
              updateTrade({ securityIdDirect: id, securityId: id });
            } else {
              updateTrade({ securityIdDirect: '' });
            }
          }}
        />

        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 rounded-2xl border border-[#30363d]">
            <label className="text-[9px] text-brand-text block mb-1 uppercase ">Total Risk (₹)</label>
            <input type="number" value={current.risk} className="w-full bg-transparent font-bold outline-none text-data-red" onChange={e => updateTrade({ risk: e.target.value })} />
          </div>
          <div className="p-3 rounded-2xl border border-[#30363d]">
            <label className="text-[9px] text-brand-text block mb-1 uppercase">ATR (5M)</label>
            <input type="number" step="0.01" value={current.atr} className="w-full bg-transparent font-bold outline-none text-data-green" onChange={e => updateTrade({ atr: e.target.value })} />
          </div>
          <div className="p-3 rounded-2xl border border-[#30363d]">
            <label className="text-[9px] text-brand-text block mb-1 uppercase">Interval (₹)</label>
            <input type="number" step="0.05" value={current.interval} className="w-full bg-transparent font-bold outline-none text-white" onChange={e => updateTrade({ interval: e.target.value })} />
          </div>
          <div className="p-3 rounded-2xl border border-[#30363d]">
            <label className="text-[9px] text-brand-text block mb-1 uppercase">Subsequent Entries</label>
            <input
              type="number"
              min={1}
              step={1}
              value={current.entriesCount}
              className="w-full bg-transparent font-bold outline-none text-white"
              onChange={e => updateTrade({ entriesCount: e.target.value })}
            />
          </div>
        </div>

        {/* RESTORED COCKPIT CARDS */}
        <div className="grid grid-cols-2 gap-3">
            <div className="bg-brand-bg border border-brand-bg/80 p-4 rounded-2xl text-center relative overflow-hidden group">
                <span className="block text-xl font-black text-brand-accent">{stats.d15.toFixed(2)} | {stats.s15}</span>
                <span className="text-[9px] text-brand-text uppercase font-bold">1.5x (Dist | Size)</span>
            </div>
            <div className="bg-brand-bg border border-brand-bg/80 p-4 rounded-2xl text-center relative overflow-hidden group">
                <span className="block text-xl font-black text-brand-accent">{stats.d20.toFixed(2)} | {stats.s20}</span>
                <span className="text-[9px] text-brand-text uppercase font-bold">2.0x (Dist | Size)</span>
            </div>
        </div>

        <div>
            <label className="text-[9px] text-brand-text uppercase block mb-1 text-center">Entry Fill Price</label>
            <input type="number" step="0.05" value={current.entry} placeholder="0.00" className="w-full bg-brand-bg p-5 rounded-2xl border border-brand-bg/80 text-3xl font-black text-center text-brand-text outline-none shadow-inner" onChange={e => updateTrade({ entry: e.target.value })} />
        </div>

        <button onClick={() => updateTrade({ symbol: '', securityId: '', securityIdDirect: '', risk: DEFAULT_RISK, atr: DEFAULT_ATR, entry: '', interval: DEFAULT_INTERVAL, entriesCount: DEFAULT_ENTRY_COUNT, searchQuery: '' })} className="w-full py-3 text-[10px] text-[#8b949e] font-black uppercase border border-[#30363d] rounded-xl hover:bg-[#21262d]">Clear Workspace</button>

        {trades.length > 1 && (
          <button 
            onClick={() => {
              const newTrades = trades.filter((_, idx) => idx !== activeIndex);
              setTrades(newTrades);
              if (activeIndex >= newTrades.length) setActiveIndex(newTrades.length - 1);
              else if (activeIndex > 0) setActiveIndex(activeIndex - 1);
            }}
            className="w-full py-3 text-[10px] text-white font-black uppercase border border-red-600 bg-red-600 hover:bg-red-700 rounded-xl transition-colors"
          >
            Delete Workspace
          </button>
        )}
      </div>
      )}

      {/* LADDERS */}
      {auth.token && (
      <div>
      {[calculateLevels(1.5), calculateLevels(2.0)].map((table, tIdx) => (
        <div key={tIdx} className="mb-10">
          <div className="flex justify-between items-center mb-4 sticky top-0  py-3 z-10 border-b border-[#161b22]">
            <h2 className="text-brand-accent font-black text-[11px] uppercase tracking-tighter">{tIdx === 0 ? '1.5x' : '2.0x'} ATR Scale-In Plan</h2>
            <button disabled={loading || !current.entry || !current.securityId} onClick={() => deploy(table.filter(r => r.isAdd))} className="bg-brand-accent text-brand-bg px-6 py-2 rounded-xl text-[10px] font-black shadow-lg disabled:opacity-20 active:scale-95 transition-all">DEPLOY {Number(current.entriesCount) || 1}</button>
          </div>
          <div className="space-y-0">
            {table.map((row, idx) => (
              <div key={idx} className={`grid grid-cols-4 py-4 border-b border-[#161b22] bg-brand-card items-center font-mono text-xs p-2 rounded`}>
                <span className={idx === 0 ? 'text-[#8b949e]' : 'text-white'}>{row.label}</span>
                <span className="text-[#8b949e] text-center font-bold">{row.qty} ({row.total || row.qty})</span>
                <span className="text-right font-black text-[#e6edf3]">{formatPrice(row.sl ?? 0)}</span>
                <div className="text-right">
                  {row.isAdd && <button onClick={() => deploy([row])} className="text-brand-accent/80 font-black  px-3 py-1 rounded-lg bg-brand-bg active:bg-[#2f81f7] transition-colors">+</button>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      </div>
      )}
    </div>
  );
}