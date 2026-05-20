'use client';
import React, { useState } from 'react';

export default function Totp({ setAuth }: { setAuth: (auth: { token: string }) => void }) {
    const [otp, setOtp] = useState('');

    const setCookie = (key: string, value: string, duration?: number) => {
        if (!key || !value) {
            throw new Error('setCookie: key and value are required');
        }
        const durationHours = duration || 24;
        const expiryDate = new Date();
        expiryDate.setHours(expiryDate.getHours() + durationHours);
        document.cookie = `${key}=${value}; expires=${expiryDate.toUTCString()}; path=/`;
    };

    const handleChange = async (val: string) => {
        setOtp(val);
        if (val.length === 6) {
            const res = await fetch(`/api/generate-auth-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ totp: val })
            });
            const data = await res.json();
            setCookie('d_token', data.token, 18);
            setAuth({ token: data.token });
        }
    }

    return (
        <div className="bg-[#0d1117] p-4 rounded-2xl border border-[#30363d] mb-4 shadow-xl">
            <label className="text-[9px] text-[#8b949e] block mb-2 uppercase font-black">Enter TOTP to Authenticate</label>
            <input
                type="text"
                value={otp}
                onChange={e => handleChange(e.target.value)}
                placeholder="000000"
                maxLength={6}
                className="w-full bg-black border border-[#30363d] p-4 rounded-xl text-lg outline-none focus:border-[#2f81f7] font-bold text-center tracking-widest"
            />
        </div>
    );
}