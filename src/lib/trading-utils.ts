// tickSize comes in paise from CSV (e.g., 5 paise = 0.05₹), convert to rupees
export const convertPaiseToRupee = (paise: number): number => {
  return paise / 100;
};

// Round to nearest tick - returns a number, not a string
export const dynamicRound = (num: number, tickSizeRupee: number): number => {
  const ts = tickSizeRupee || 0.05;
  const inv = 1 / ts;
  return Math.round(num * inv) / inv;
};

// Format price to 2 decimals for display
export const formatPrice = (num: number): string => {
  return num.toFixed(2);
};

export const generateId = () => Math.random().toString(36).substring(2, 9);