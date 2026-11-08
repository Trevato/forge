/** Sizes and spans as /system and the terminal both print them. */
export const bytes = (n: number): string => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

const BLOCKS = "▁▂▃▄▅▆▇█";
/** A history as block characters, one per reading, each 0–100; one that is not a finite number draws the lowest. */
export const spark = (history: readonly number[]): string =>
  history.map((n) => BLOCKS[Number.isFinite(n) ? Math.min(7, Math.max(0, Math.floor((n / 100) * 8))) : 0]).join("");

export const span = (s: number): string =>
  s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172_800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86_400)}d`;
