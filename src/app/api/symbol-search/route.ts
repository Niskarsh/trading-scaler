import { NextResponse } from 'next/server';
import Papa from 'papaparse';
import fs from 'fs';
import path from 'path';

let cachedMaster: any[] = [];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.toLowerCase() || '';
  const segmentFilter = searchParams.get('segment') || 'NSE_EQ';

  try {
    if (cachedMaster.length === 0) {
      const csvPath = path.join(process.cwd(), 'public', 'api-scrip-master-detailed.csv');
      const csv = await fs.promises.readFile(csvPath, 'utf8');
      const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true }).data;
      cachedMaster = parsed;
    }

    const filtered = cachedMaster
      .filter((s: any) => {
        // Map CSV EXCH_ID to Dhan API segments
        const isNseEq = segmentFilter === 'NSE_EQ' && s.EXCH_ID === 'NSE' && s.INSTRUMENT === 'EQUITY';
        const isMcx = segmentFilter === 'MCX_COMM' && s.EXCH_ID === 'MCX';
        const isNseFno = segmentFilter === 'NSE_FNO' && s.EXCH_ID === 'NSE' && s.INSTRUMENT !== 'EQUITY';
        
        return (isNseEq || isMcx || isNseFno) && s.SYMBOL_NAME?.toLowerCase().includes(query);
      })
      .slice(0, 8)
      .map((s: any) => ({
        symbol: s.SYMBOL_NAME,
        displayName: s.DISPLAY_NAME,
        id: s.SECURITY_ID,
        tickSize: parseFloat(s.TICK_SIZE) || 0.05
      }));

    return NextResponse.json(filtered);
  } catch (err) {
    return NextResponse.json({ error: "Search Failed" }, { status: 500 });
  }
}