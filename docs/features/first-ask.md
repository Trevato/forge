# Refused first asks (#11525)

When the forge refuses a first ask, it keeps one row: who asked, the first 200 characters and the refusal's words. No claim code, token or email is kept.

- **Where they are read:** `/forges/refused` (the newest 20, newest first), linked from `/forges` (with the count, once there is one) and from `/system`; the same rows are in the terminal. Only a forge admin who is a person may read them; anyone else gets what `/forges` gives.
- **Capped at 20 per person per hour:** past that, the next refusal is dropped silently.
- **Kept 30 days:** older rows are pruned on write and never listed.
- Code: `src/core/first_ask_refusals.ts`, `src/web/pages/forges-refused.ts`; tests in `test/forges-refused.test.ts`.
