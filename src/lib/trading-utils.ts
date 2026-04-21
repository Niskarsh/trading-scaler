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

// NSE round to 5 paise (0.05₹)
export const nseRound = (num: number): number => {
  return parseFloat((Math.floor(Math.round(num * 100) / 5) * 5 / 100).toFixed(2));
};

// Format price to 2 decimals for display
export const formatPrice = (num: number): string => {
  return num.toFixed(2);
};

export const generateId = () => Math.random().toString(36).substring(2, 9);