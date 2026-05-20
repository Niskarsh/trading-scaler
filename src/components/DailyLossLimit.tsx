'use client';

import React, { useEffect, useState } from 'react';

type DailyLossLimitPayload = {
  pnlExitStatus?: 'ACTIVE' | 'INACTIVE';
  profit?: string;
  loss?: string;
  productType?: Array<'INTRADAY' | 'DELIVERY'>;
  enable_kill_switch?: boolean;
};

interface DailyLossLimitProps {
  token: string;
}

export default function DailyLossLimit({ token }: DailyLossLimitProps) {
  const [dailyLossLimit, setDailyLossLimit] = useState<DailyLossLimitPayload | null>(null);
  const [lossValueInput, setLossValueInput] = useState('');
  const [dailyLimitLoading, setDailyLimitLoading] = useState(false);
  const [dailyLimitSaving, setDailyLimitSaving] = useState(false);
  const [dailyLimitError, setDailyLimitError] = useState('');

  const fetchDailyLossLimit = async (token: string) => {
    try {
      setDailyLimitError('');
      setDailyLimitLoading(true);
      const res = await fetch('/api/daily-loss-limit', {
        headers: { 'x-dhan-token': token },
      });
      const payload = await res.json();
      if (!res.ok) {
        setDailyLossLimit(null);
        setDailyLimitError(payload?.error || 'Unable to load daily loss limit.');
        return;
      }
      setDailyLossLimit(payload?.pnlLimitData || null);
      if (payload?.pnlLimitData?.loss) {
        setLossValueInput(payload.pnlLimitData.loss);
      }
    } catch (err: unknown) {
      setDailyLossLimit(null);
      setDailyLimitError(err instanceof Error ? err.message : 'Unable to load daily loss limit.');
    } finally {
      setDailyLimitLoading(false);
    }
  };

  const saveDailyLossLimit = async () => {
    if (!token || !lossValueInput) return;
    try {
      setDailyLimitSaving(true);
      setDailyLimitError('');
      const res = await fetch('/api/daily-loss-limit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-dhan-token': token,
        },
        body: JSON.stringify({ lossValue: lossValueInput, productType: ['INTRADAY'] }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setDailyLimitError(payload?.error || 'Unable to save daily loss limit.');
        return;
      }
      await fetchDailyLossLimit(token);
      alert('Daily loss limit saved successfully.');
    } catch (err: unknown) {
      setDailyLimitError(err instanceof Error ? err.message : 'Unable to save daily loss limit.');
    } finally {
      setDailyLimitSaving(false);
    }
  };

  useEffect(() => {
    if (!token) {
      setDailyLossLimit(null);
      setDailyLimitError('');
      return;
    }
    fetchDailyLossLimit(token);
  }, [token]);

  return (
    <div className="bg-[#0d1117] p-5 rounded-3xl border border-[#30363d] mb-6 shadow-xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-[#8b949e] font-black">Daily Loss Limit</p>
          <p className="text-[11px] text-white font-bold">Manage intraday loss protection</p>
        </div>
        {dailyLimitLoading && <span className="text-[10px] text-[#8b949e]">Checking limit...</span>}
      </div>

      {dailyLimitError ? (
        <div className="mb-4 rounded-2xl border border-red-600/30 bg-red-600/10 p-3 text-xs text-red-200">{dailyLimitError}</div>
      ) : null}

      {dailyLossLimit && dailyLossLimit.pnlExitStatus === 'ACTIVE' && dailyLossLimit.loss ? (
        <div className="grid grid-cols-2 gap-3 mb-4 text-sm text-[#c9d1d9]">
          <div className="bg-black border border-[#30363d] rounded-2xl p-4">
            <p className="text-[9px] uppercase text-[#8b949e] mb-2">Status</p>
            <p className="font-black">{dailyLossLimit.pnlExitStatus}</p>
          </div>
          <div className="bg-black border border-[#30363d] rounded-2xl p-4">
            <p className="text-[9px] uppercase text-[#8b949e] mb-2">Kill Switch</p>
            <p className="font-black">{dailyLossLimit.enable_kill_switch ? 'Enabled' : 'Disabled'}</p>
          </div>
          <div className="bg-black border border-[#30363d] rounded-2xl p-4">
            <p className="text-[9px] uppercase text-[#8b949e] mb-2">Loss Limit</p>
            <p className="font-black">₹{dailyLossLimit.loss}</p>
          </div>
          <div className="bg-black border border-[#30363d] rounded-2xl p-4">
            <p className="text-[9px] uppercase text-[#8b949e] mb-2">Product Type</p>
            <p className="font-black">{dailyLossLimit.productType?.join(', ') || 'INTRADAY'}</p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[11px] text-[#8b949e]">No active daily loss limit is set for intraday. Enter a loss value to enable the kill switch.</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-black border border-[#30363d] rounded-2xl p-3">
              <label className="text-[9px] uppercase text-[#8b949e] block mb-1">Loss Value (₹)</label>
              <input
                type="number"
                step="0.01"
                value={lossValueInput}
                onChange={e => setLossValueInput(e.target.value)}
                className="w-full bg-transparent text-white font-bold outline-none"
                placeholder="Enter loss limit"
              />
            </div>
          </div>
          <button
            disabled={dailyLimitSaving || !lossValueInput}
            onClick={saveDailyLossLimit}
            className="w-full py-3 text-[10px] text-white font-black uppercase rounded-xl bg-[#2f81f7] disabled:opacity-40"
          >
            {dailyLimitSaving ? 'Saving...' : 'Enable Intraday Kill Switch'}
          </button>
        </div>
      )}
    </div>
  );
}
