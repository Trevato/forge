/**
 * Identifiers. `id()` is time-sortable and index-friendly (ULID layout:
 * 48-bit millisecond timestamp + 80 bits of randomness, lowercase Crockford
 * base32, 26 chars). `secret()` is for credentials only — pure entropy,
 * never sortable, never logged.
 */

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford, lowercase

export function id(now: number = Date.now()): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);

  let out = "";
  // 48-bit timestamp → 10 base32 chars, most significant first.
  for (let shift = 45; shift >= 0; shift -= 5) {
    out += alphabet[Math.floor(now / 2 ** shift) % 32];
  }
  // 80 random bits → 16 base32 chars, 5 bits at a time.
  let acc = 0;
  let accBits = 0;
  for (const byte of bytes) {
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

/** 256 bits of entropy, base64url, ~43 chars. For tokens and session ids. */
export function secret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}
