/**
 * Identifiers. `id()` is time-sortable and index-friendly (ULID layout:
 * 48-bit millisecond timestamp + 80 bits of randomness, lowercase Crockford
 * base32, 26 chars). It is **monotonic**: two ids from the same millisecond
 * are still strictly increasing (the random field is incremented), so
 * lexicographic order always matches creation order — the property every
 * id-ordered listing (comments, events, issues) quietly depends on.
 * `secret()` is for credentials only — pure entropy, never sortable.
 */

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford, lowercase

// Monotonic state: the last timestamp handed out and its 80-bit random field.
let lastMs = -1;
const lastRand = new Uint8Array(10);

export function id(now: number = Date.now()): string {
  if (now <= lastMs) {
    // Same millisecond (or a clock that ran backwards): keep the timestamp and
    // increment the random field, big-endian, so the id still strictly grows.
    now = lastMs;
    for (let i = 9; i >= 0; i--) {
      if (lastRand[i]! < 255) {
        lastRand[i]!++;
        break;
      }
      lastRand[i] = 0;
    }
  } else {
    lastMs = now;
    crypto.getRandomValues(lastRand);
  }

  let out = "";
  // 48-bit timestamp → 10 base32 chars, most significant first.
  for (let shift = 45; shift >= 0; shift -= 5) {
    out += alphabet[Math.floor(now / 2 ** shift) % 32];
  }
  // 80 random bits → 16 base32 chars, 5 bits at a time.
  let acc = 0;
  let accBits = 0;
  for (const byte of lastRand) {
    acc = (acc << 8) | byte;
    accBits += 8;
    while (accBits >= 5) {
      accBits -= 5;
      out += alphabet[(acc >> accBits) & 31];
      acc &= (1 << accBits) - 1;
    }
  }
  return out;
}

/**
 * The least id `id()` hands out at `ms`: every id made at or after it sorts
 * at or above this, so a time window over an id-indexed table is a range.
 */
export function idFloor(ms: number): string {
  let out = "";
  for (let shift = 45; shift >= 0; shift -= 5) out += alphabet[Math.floor(Math.max(0, ms) / 2 ** shift) % 32];
  return out + "0".repeat(16);
}

/** 256 bits of entropy, base64url, ~43 chars. For tokens and session ids. */
export function secret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}
