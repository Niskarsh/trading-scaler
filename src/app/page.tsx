'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { dynamicRound, convertPaiseToRupee, formatPrice, generateId } from '@/lib/trading-utils';
import SymbolSearch from '@/components/SymbolSearch';

interface TradeWorkspace {
  id: string;
  symbol: string;
  securityId: string;
  tickSize: number;
  segment: string;
  risk: string;
  atr: string;
  entry: string;
  extraCount: number;
}

export default function UnifiedCommandCenter() {
  const [auth, setAuth] = useState({ token: '' });
  const [trades, setTrades] = useState<TradeWorkspace[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const isProcessing = useRef(false);

  useEffect(() => {
    setAuth({ token: localStorage.getItem('d_token') || '' });
    const saved = JSON.parse(localStorage.getItem('active_workspaces') || '[]');
    if (saved.length > 0) setTrades(saved);
    else addNewTrade();
  }, []);

  useEffect(() => {
    if (trades.length > 0) localStorage.setItem('active_workspaces', JSON.stringify(trades));
    if (auth.token) localStorage.setItem('d_token', auth.token);
  }, [trades, auth]);

  const current = trades[activeIndex] || { segment: 'NSE_EQ', risk: '47', atr: '', entry: '', securityId: '', tickSize: 5 };

  const updateTrade = (updates: Partial<TradeWorkspace>) => {
    setTrades(prev => {
      const next = [...prev];
      next[activeIndex] = { ...next[activeIndex], ...updates };
      return next;
    });
  };

  const addNewTrade = () => {
    setTrades([...trades, { id: generateId(), symbol: '', securityId: '', tickSize: 5, segment: 'NSE_EQ', risk: '47', atr: '', entry: '', extraCount: 0 }]);
    setActiveIndex(trades.length);
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

  const calculateLevels = (multiplier: number) => {
    const r = parseFloat(current.risk) || 47;
    const a = parseFloat(current.atr);
    const e = parseFloat(current.entry);
    const tsPaise = current.tickSize || 5; // tickSize in paise from CSV
    const tsRupee = convertPaiseToRupee(tsPaise); // convert to rupees
    if (!a || !e) return [];

    const dist = a * multiplier;
    const initQty = Math.floor(r / dist);
    const addQty = Math.floor(initQty * 0.5);
    
    let shares = initQty;
    let bank = 0;
    const rows = [];
    console.log(`Calculating levels with Entry: ${e}, ATR: ${a}, Risk: ${r}, Multiplier: ${multiplier}, Initial Qty: ${initQty}, Add Qty: ${addQty} tickSize: ${tsRupee}₹`);
    const startPrice = dynamicRound(e - tsRupee, tsRupee);
    const startSL = dynamicRound(e + dist, tsRupee);
    rows.push({ label: 'START', trigger: formatPrice(e), price: startPrice, qty: initQty, sl: startSL, isAdd: false });

    for (let i = 1; i <= (7 + current.extraCount); i++) {
      const trigger = e - i;
      bank += shares;
      shares += addQty;
      const slPrice = dynamicRound(trigger + ((r + bank) / shares), tsRupee);
      const price = dynamicRound(trigger - (tsRupee * 2), tsRupee);
      rows.push({ label: `₹${formatPrice(trigger)}`, trigger: formatPrice(trigger), price: price, qty: addQty, total: shares, sl: slPrice, isAdd: true });
    }
    return rows;
  };

  const deploy = async (orders: any[]) => {
    if (isProcessing.current || !current.securityId || !auth.token) return alert("Verify Token/ID First!");
    try {
      isProcessing.current = true;
      setLoading(true);
      const res = await fetch('/api/place-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dhan-token': auth.token },
        body: JSON.stringify({ orders, tradingSymbol: current.symbol, securityId: current.securityId, segment: current.segment })
      });
      const data = await res.json();
      alert(`SUCCESS: ${data.count} Orders Live.`);
    } finally {
      isProcessing.current = false;
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#010409] text-[#e6edf3] p-4 font-sans max-w-lg mx-auto pb-24">
      {/* AUTH */}
      <div className="bg-[#0d1117] p-4 rounded-2xl border border-[#30363d] mb-4 shadow-xl">
        <input type="password" placeholder="Dhan Access Token" value={auth.token} className="w-full bg-black border border-[#30363d] p-4 rounded-xl text-xs text-center font-mono outline-none focus:border-[#2f81f7]" onChange={e => setAuth({ token: e.target.value })} />
      </div>

      {/* TABS */}
      <div className="flex items-center space-x-2 overflow-x-auto pb-4 mb-4 no-scrollbar border-b border-[#30363d]">
        {trades.map((t, i) => (
          <button key={t.id} onClick={() => setActiveIndex(i)} className={`flex-shrink-0 px-5 py-2 rounded-xl text-xs font-bold transition-all border ${i === activeIndex ? 'bg-[#2f81f7] border-[#2f81f7] text-white shadow-lg shadow-blue-500/20' : 'bg-[#0d1117] text-[#8b949e] border-[#30363d]'}`}>
            {t.symbol || 'EMPTY'}
          </button>
        ))}
        <button onClick={addNewTrade} className="bg-[#21262d] px-4 py-2 rounded-xl text-[#2f81f7] font-black">+</button>
      </div>

      {/* WORKSPACE */}
      <div className="bg-[#0d1117] p-5 rounded-3xl border border-[#30363d] mb-6 space-y-4 shadow-2xl">
        <div className="flex justify-between items-center">
            <span className="text-[10px] text-[#2f81f7] font-black uppercase tracking-widest">ID: {current.securityId || "---"}</span>
            <select value={current.segment} onChange={e => updateTrade({ segment: e.target.value, symbol: '', securityId: '' })} className="bg-black border border-[#30363d] text-[10px] font-bold text-[#3fb950] p-1 rounded uppercase outline-none">
                <option value="NSE_EQ">NSE Cash</option>
                <option value="MCX_COMM">MCX Comm</option>
            </select>
        </div>

        <SymbolSearch segment={current.segment} onSelect={(sym, id, ts) => updateTrade({ symbol: sym, securityId: id, tickSize: ts })} />

        <div className="grid grid-cols-2 gap-3">
          <div className="bg-black p-3 rounded-2xl border border-[#30363d]">
            <label className="text-[9px] text-[#8b949e] block mb-1 uppercase font-black">Total Risk (₹)</label>
            <input type="number" value={current.risk} className="w-full bg-transparent font-bold outline-none text-white" onChange={e => updateTrade({ risk: e.target.value })} />
          </div>
          <div className="bg-black p-3 rounded-2xl border border-[#30363d]">
            <label className="text-[9px] text-[#8b949e] block mb-1 uppercase font-black">ATR (5M)</label>
            <input type="number" step="0.01" value={current.atr} className="w-full bg-transparent font-bold outline-none text-white" onChange={e => updateTrade({ atr: e.target.value })} />
          </div>
        </div>

        {/* RESTORED COCKPIT CARDS */}
        <div className="grid grid-cols-2 gap-3">
            <div className="bg-black border border-[#30363d] p-4 rounded-2xl text-center relative overflow-hidden group">
                <span className="block text-xl font-black text-[#3fb950]">{stats.d15.toFixed(2)} | {stats.s15}</span>
                <span className="text-[9px] text-[#8b949e] uppercase font-bold">1.5x (Dist | Size)</span>
            </div>
            <div className="bg-black border border-[#30363d] p-4 rounded-2xl text-center relative overflow-hidden group">
                <span className="block text-xl font-black text-[#3fb950]">{stats.d20.toFixed(2)} | {stats.s20}</span>
                <span className="text-[9px] text-[#8b949e] uppercase font-bold">2.0x (Dist | Size)</span>
            </div>
        </div>

        <div>
            <label className="text-[9px] text-[#8b949e] uppercase block mb-1 text-center font-black">Entry Fill Price</label>
            <input type="number" step="0.05" value={current.entry} placeholder="0.00" className="w-full bg-black p-5 rounded-2xl border border-[#30363d] text-3xl font-black text-center text-[#2f81f7] outline-none shadow-inner" onChange={e => updateTrade({ entry: e.target.value })} />
        </div>

        <button onClick={() => updateTrade({ atr: '', entry: '', extraCount: 0 })} className="w-full py-3 text-[10px] text-[#8b949e] font-black uppercase border border-[#30363d] rounded-xl hover:bg-[#21262d]">Clear Workspace</button>
      </div>

      {/* LADDERS */}
      {[calculateLevels(1.5), calculateLevels(2.0)].map((table, tIdx) => (
        <div key={tIdx} className="mb-10">
          <div className="flex justify-between items-center mb-4 sticky top-0 bg-[#010409] py-3 z-10 border-b border-[#161b22]">
            <h2 className="text-[#2f81f7] font-black text-[11px] uppercase tracking-tighter">{tIdx === 0 ? '1.5x' : '2.0x'} ATR Scale-In Plan</h2>
            <button disabled={loading || !current.entry || !current.securityId} onClick={() => deploy(table.filter(r => r.isAdd).slice(0, 7))} className="bg-[#2f81f7] px-6 py-2 rounded-xl text-[10px] font-black shadow-lg disabled:opacity-20 active:scale-95 transition-all">DEPLOY 7</button>
          </div>
          <div className="space-y-0">
            {table.map((row, idx) => (
              <div key={idx} className={`grid grid-cols-4 py-4 border-b border-[#161b22] items-center font-mono text-xs ${idx === 0 ? 'bg-[#0d1117] rounded-xl px-2 my-1 border-none shadow-md' : ''}`}>
                <span className={idx === 0 ? 'text-[#8b949e]' : 'text-white'}>{row.label}</span>
                <span className="text-[#8b949e] text-center font-bold">{row.qty} ({row.total || row.qty})</span>
                <span className="text-right font-black text-[#e6edf3]">{formatPrice(row.sl)}</span>
                <div className="text-right">
                  {row.isAdd && <button onClick={() => deploy([row])} className="text-[#2f81f7] border border-[#2f81f7]/40 px-3 py-1 rounded-lg active:bg-[#2f81f7] transition-colors">+</button>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </main>
  );
}