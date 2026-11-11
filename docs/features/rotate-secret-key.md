# Rotating the secret key

`secret.key` in the data directory seals every stored credential. To replace
it — it leaked, or a person who held it left — stop the forge, then:

    FORGE_DATA=/data bun scripts/rotate-secret-key.ts           # dry run: counts only
    FORGE_DATA=/data bun scripts/rotate-secret-key.ts --apply   # writes

`--apply` mints a new key, re-seals every sealed column (origin and OAuth
tokens, account tokens, prompt-source tokens, secrets, app variables, secret
feature settings, the OIDC signing key) under it in one transaction, then
keeps the old key as `secret.key.old` and puts the new one in place. It prints
counts per table and key ids, never a value. A write that fails rolls the
whole re-seal back and leaves the old key where it was.

While `secret.key.old` is there a rotation is under way: a run mints nothing
and only moves what is still under an older key onto the current one, so
running it again moves nothing — and the by-hand rotation (move `secret.key`
to `secret.key.old`, restart) is finished by the same command. Start the
forge, check that origins and secrets work, then delete `secret.key.old`; the
next run starts a new rotation.

- Passports and visitor links are signed with keys derived from `secret.key`,
  so they end with it.
- A value counted "unopenable" opens under no key the directory holds and is
  left as it is. The report then warns to keep `secret.key.old`, and `--apply`
  exits 3, so a script driving the rotation does not go on to delete it.
- A new sealed column must be added to `SEALED_COLUMNS` in
  `scripts/rotate-secret-key.ts`; test/rotate-secret-key.test.ts fails on any
  `*_enc` column in the schema that is missing from it.
