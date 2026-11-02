/** Dollars as every surface writes them, the board, its returns page and the terminal alike. */

/** Cents under ten, whole above. */
export const usd = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
