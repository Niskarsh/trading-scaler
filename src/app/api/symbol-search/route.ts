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
    
    console.log('Starting CSV streaming load...');
    Papa.parse(stream, {
      header: true,
      skipEmptyLines: true,
      step: (row) => {
        results.push(row.data);
        rowCount++;
        if (rowCount % 5000 === 0) {
          console.log(`Loaded ${rowCount} rows...`);
        }
      },
      complete: () => {
        console.log(`CSV loading complete. Total rows: ${rowCount}`);
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
//   console.log(`Parsing complete. Total rows: ${parsed.length}`);
//   cachedMaster = parsed;
//   return parsed;
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