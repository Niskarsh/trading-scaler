import { NextResponse } from 'next/server';
import Papa from 'papaparse';
import fs from 'fs';
import path from 'path';

let cachedMaster: any[] = [];

async function loadData() {
  return new Promise((resolve, reject) => {
    const csvPath = path.join(process.cwd(), 'public', 'api-scrip-master-detailed.csv');
    const stream = fs.createReadStream(csvPath, { encoding: 'utf8' });
    const results: any[] = [];
    let rowCount = 0;
    
    console.log('Starting CSV streaming load (filtered fields only)...');
    Papa.parse(stream, {
      header: true,
      skipEmptyLines: true,
      step: (row) => {
        // Only keep the fields we need to reduce memory footprint
        const data = row.data as Record<string, string>;
        const filtered = {
          EXCH_ID: data.EXCH_ID,
          INSTRUMENT: data.INSTRUMENT,
          SYMBOL_NAME: data.SYMBOL_NAME,
          DISPLAY_NAME: data.DISPLAY_NAME,
          SECURITY_ID: data.SECURITY_ID,
          TICK_SIZE: data.TICK_SIZE
        };
        results.push(filtered);
        rowCount++;
        if (rowCount % 10000 === 0) {
          const memUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
          console.log(`Loaded ${rowCount} rows... Memory: ${memUsage}MB`);
        }
      },
      complete: () => {
        const memUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        console.log(`CSV loading complete. Total rows: ${rowCount}, Memory: ${memUsage}MB`);
        cachedMaster = results;
        resolve(results);
      },
      error: (error) => {
        console.error('CSV parsing error:', error);
        reject(error);
      }
    });
  });
}

// Alternative simple approach (uncomment if EC2 RAM is increased):
// async function loadDataSimple() {
//   const csvPath = path.join(process.cwd(), 'public', 'api-scrip-master-detailed.csv');
//   console.log('Loading CSV with simple readFile...');
//   const csv = await fs.promises.readFile(csvPath, 'utf8');
//   console.log('File read complete, parsing...');
//   const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true }).data;
//   const filtered = parsed.map(row => ({
//     EXCH_ID: row.EXCH_ID,
//     INSTRUMENT: row.INSTRUMENT,
//     SYMBOL_NAME: row.SYMBOL_NAME,
//     DISPLAY_NAME: row.DISPLAY_NAME,
//     SECURITY_ID: row.SECURITY_ID,
//     TICK_SIZE: row.TICK_SIZE
//   }));
//   console.log(`Parsing complete. Total rows: ${filtered.length}`);
//   cachedMaster = filtered;
//   return filtered;
// }

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.toLowerCase() || '';
  const segmentFilter = searchParams.get('segment') || 'NSE_EQ';

  console.log(`Symbol search request - Query: "${query}", Segment: ${segmentFilter}`);

  try {
    if (cachedMaster.length === 0) {
      console.log('Cache empty, loading data...');
      await loadData();
      console.log('Data loaded and cached successfully');
    } else {
      console.log('Using cached data');
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

    console.log(`Search completed. Found ${filtered.length} matches`);

    return NextResponse.json(filtered);
  } catch (err) {
    console.error('Search failed:', err);
    return NextResponse.json({ error: "Search Failed" }, { status: 500 });
  }
}