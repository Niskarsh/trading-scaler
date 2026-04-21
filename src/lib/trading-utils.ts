export const dynamicRound = (num: number, tickSize: number): string => {
  const ts = tickSize || 0.05;
  const inv = 1 / ts;
  return (Math.floor(Math.round(num * inv * 100) / 100) / inv).toFixed(2);
};

export const generateId = () => Math.random().toString(36).substring(2, 9);