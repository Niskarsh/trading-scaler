'use client';
import React, { useState } from 'react';

export default function SymbolSearch({ 
  segment, 
  searchQuery, 
  onSearchChange, 
  onSelect,
  securityIdDirect,
  onSecurityIdDirectChange
}: { 
  segment: string, 
  searchQuery: string, 
  onSearchChange: (query: string) => void, 
  onSelect: (sym: string, id: string, ts: number) => void,
  securityIdDirect: string,
  onSecurityIdDirectChange: (id: string) => void
}) {
  type SearchResult = { symbol: string; displayName?: string; id: string; tickSize: number };
  const [results, setResults] = useState<SearchResult[]>([]);
  const isSecurityIdMode = securityIdDirect.length > 0;

  const handleSearch = async (val: string) => {
    onSearchChange(val);
    if (val.length < 2) return setResults([]);
    const res = await fetch(`/api/symbol-search?q=${val}&segment=${segment}`);
    const data = await res.json();
    if (Array.isArray(data)) setResults(data);
  };

  const handleSelect = (sym: string, id: string, ts: number) => {
    onSelect(sym, id, ts);
    setResults([]);
  };

  const handleClearSecurityId = () => {
    onSecurityIdDirectChange('');
  };

  return (
    <div className="space-y-3">
      {/* Direct Security ID Input */}
      <div className="relative">
        <div className="flex items-center gap-2">
          <input 
            type="text" 
            value={securityIdDirect} 
            onChange={e => onSecurityIdDirectChange(e.target.value)}
            placeholder="Or enter Security ID directly..."
            className="flex-1 bg-black border border-[#30363d] p-4 rounded-xl text-sm outline-none focus:border-[#3fb950] font-bold"
          />
          {securityIdDirect && (
            <button 
              onClick={handleClearSecurityId}
              className="px-3 py-2 bg-red-600/20 hover:bg-red-600/40 border border-red-600/40 rounded-lg text-red-400 font-bold text-xs transition-colors flex-shrink-0"
              title="Clear Security ID"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Search Box (disabled when Security ID is set) */}
      <div className="relative">
        <input 
          type="text" 
          value={searchQuery} 
          onChange={e => handleSearch(e.target.value)}
          disabled={isSecurityIdMode}
          placeholder={isSecurityIdMode ? `Search disabled (Security ID set)` : `Search ${segment}...`}
          className={`w-full bg-black border p-4 rounded-xl text-sm outline-none font-bold transition-colors ${
            isSecurityIdMode 
              ? 'border-[#30363d] text-[#6e7681] cursor-not-allowed opacity-50' 
              : 'border-[#30363d] focus:border-[#2f81f7]'
          }`}
        />
        {results.length > 0 && !isSecurityIdMode && (
          <div className="absolute z-50 w-full bg-[#0d1117] border border-[#30363d] mt-1 rounded-xl shadow-2xl">
            {results.map(s => (
              <div key={s.id} onClick={() => handleSelect(s.symbol, s.id, s.tickSize)} className="p-4 hover:bg-[#21262d] border-b border-[#30363d] last:border-0 flex justify-between items-center cursor-pointer">
                <span className="font-bold text-xs">{s.symbol}</span>
                <span className="text-[10px] text-[#2f81f7] font-mono">ID: {s.id}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}