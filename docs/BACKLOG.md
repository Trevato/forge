# Backlog

Tracked here until issues can be filed. Drafted by Prototyper.

# Global inherited Resend email secret with per-app/per-domain override

## Goal
Preview/prototyping email works out of the box in every downstream forge and app, inheriting a platform-level Resend API key by default.

## Override
Any app or domain can be given its own Resend token, which takes precedence over the inherited one.

## Doing it right
- Build on the existing scoped, write-only forge secrets (docs/APPS.md "Forge secrets").
- Key never exposed to unauthorized apps or logs; spawned children send *through* the parent key rather than receiving it raw.
- Clear inheritance chain: platform > forge > domain > app.
- Rotation/revocation without redeploys.
- Admins can see which scope's key is in effect (without revealing it).
- Optional sending-domain / from-address restriction per scope.
- Rate limits and quotas on the shared key.

## Acceptance criteria
1. A freshly spawned forge/app sends email with zero setup.
2. A per-app/per-domain key overrides the inherited one; removing it falls back up the chain.
3. The key never appears in API responses, pages, logs, or argv.
4. Rotating/revoking the platform key takes effect everywhere it's inherited.
5. The effective scope is visible to admins.
6. Shared-key sends are rate-limited per scope and restricted to allowed from-domains.
7. Tests cover inheritance, override, and redaction.

# Forge issues ready to file (trevato-apps/forge)

## 1. Self-serve signup is disabled with no path from the forge homepage
forge.open-platform.sh offers only "Sign in" (-> git.open-platform.sh/user/login). /user/sign_up says "Registration is disabled." No OAuth. Blocks selling hosted forges.
AC: public signup (with email verification + rate limit/captcha) or an invite flow linked from the homepage.

## 2. No token-based auth for the forge API from Forgejo PATs
Forge UI (Bun) has separate accounts; Forgejo PAT -> 401 on /api/v1/*. Tokens only via POST /api/v1/tokens with password.
AC: document token creation; optionally accept scoped Forgejo PATs or OAuth.

## 3. Claim link shown only once on spawn
Easy to lose; anonymous spawns then can't get a crew without an admin re-issuing.
AC: let the spawner re-request it (e.g. emailed or tied to session), or show it again on a status page.

## 4. modelEndpoint/OpenRouter not documented
subscriptions.ts says the base URL should omit /v1; docs don't. OpenRouter users will set https://openrouter.ai/api/v1 and break.
AC: document it, and normalize a trailing /v1 automatically.

## 5. Child forge 404 is bare "not found"
<name>--forge.open-platform.sh for unknown or stopped forges gives plain text.
AC: branded page saying "not spawned / stopped / misrouted" with a "spawn one" link.

## 6. No /docs and no docs link in UI
/docs 404; docs only in repo.
AC: serve docs/ at /docs and link from the header.

## 7. Homepage repo list mixes platform, demos, third-party repos
AC: grouped sections with headings.

## 8. Global inherited Resend secret (see resend-issue.md)
