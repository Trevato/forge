/** Content hashing. Credentials are high-entropy, so a fast hash is correct
 * for lookup tables — argon2 (Bun.password) is for human passwords only. */

export function sha256(input: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}
