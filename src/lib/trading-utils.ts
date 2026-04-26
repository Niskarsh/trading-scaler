// tickSize comes in paise from CSV (e.g., 5 paise = 0.05₹), convert to rupees
export const convertPaiseToRupee = (paise: number): number => {
  return paise / 100;
};

// Round to nearest tick - returns a number, not a string
export const dynamicRound = (num: number, tickSizeRupee: number): number => {
  const ts = tickSizeRupee || 0.05;
  const inv = 1 / ts;
  return Math.floor(num * inv) / inv;
};

// NSE round to nearest tick size (default 5 paise)
export const roundToTick = (num: number, tickSizeRupee = 0.05): number => {
  const tickSizePaise = Math.round(tickSizeRupee * 100);
  const paise = Math.round(num * 100);
  const remainder = paise % tickSizePaise;
  if (remainder === 0) return parseFloat((paise / 100).toFixed(2));

  const halfTick = Math.floor(tickSizePaise / 2);
  const roundedPaise = remainder >= halfTick
    ? paise + (tickSizePaise - remainder)
    : paise - remainder;

  return parseFloat((roundedPaise / 100).toFixed(2));
};

// NSE round to 5 paise (0.05₹)
export const nseRound = (num: number): number => roundToTick(num, 0.05);

// Normalize tick size to rupees.
// - NSE_EQ uses fixed 5 paise tick size.
// - Other segments can provide paise values from source CSV, so convert if > 1.
export const normalizeTickSize = (tickSize: number, segment = 'NSE_EQ'): number => {
  if (segment === 'NSE_EQ') return 0.05;
  if (!tickSize) return 0.05;
  return tickSize > 1 ? convertPaiseToRupee(tickSize) : tickSize;
};

// Format price to 2 decimals for display
export const formatPrice = (num: number): string => {
  return num.toFixed(2);
};

export const generateId = () => Math.random().toString(36).substring(2, 9);