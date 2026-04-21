'use client';
import React, { useState } from 'react';

export default function SymbolSearch({ segment, onSelect }: { segment: string, onSelect: (sym: string, id: string, ts: number) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);

  const handleSearch = async (val: string) => {
    setQuery(val);
    if (val.length < 2) return setResults([]);
    const res = await fetch(`/api/symbol-search?q=${val}&segment=${segment}`);
    const data = await res.json();
    if (Array.isArray(data)) setResults(data);
  };

  return (
    <div className="relative">
      <input 
        type="text" value={query} onChange={e => handleSearch(e.target.value)}
        placeholder={`Search ${segment}...`}
        className="w-full bg-black border border-[#30363d] p-4 rounded-xl text-sm outline-none focus:border-[#2f81f7] font-bold"
      />
      {results.length > 0 && (
        <div className="absolute z-50 w-full bg-[#0d1117] border border-[#30363d] mt-1 rounded-xl shadow-2xl">
          {results.map(s => (
            <div key={s.id} onClick={() => { onSelect(s.symbol, s.id, s.tickSize); setQuery(s.symbol); setResults([]); }} className="p-4 hover:bg-[#21262d] border-b border-[#30363d] last:border-0 flex justify-between items-center">
              <span className="font-bold text-xs">{s.symbol}</span>
              <span className="text-[10px] text-[#2f81f7] font-mono">ID: {s.id}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}