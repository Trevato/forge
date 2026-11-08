# Security runbook

This runbook says what to do when the forge is under load, a token leaks, an account looks wrong, a release is bad or sign-in breaks. It is for the forge's owner, with no AI at hand. Each step works from the browser or with `curl`, and each says how to undo it. Keep a copy off the forge (print it, or keep a clone), since you may need it when the forge is down.

Start at **Settings → Security** (`/settings/security`). It shows the Shield, traffic, admins, admin tokens, recent keys, deleted repositories, backups and the last secret scan, each with when it was checked.

Three things to know:

- Nothing here needs a terminal unless the forge won't answer.
- Every change here can be undone. Each section says how.
- A token is a password. Never paste one on a command line, into a chat or into an issue. The commands below read it from a hidden prompt.

## The forge is slow or under load

1. Open `/settings/traffic`. It says who is using the forge's answering time.
2. If it's **anonymous deep pages** or **named crawlers**, turn the Shield to **Sign-in only** (below). This is safe: signed-in people, tokens, repository front pages and `git clone` keep working.
3. If it's still slow after two minutes, or you can't reach the forge, go to [Cloudflare](#cloudflare-challenge-or-under-attack).
4. If it's **people and tokens**, find the token or account on `/settings/accounts` and go to [An account looks wrong](#an-account-looks-wrong).

**Undo:** press **Undo** on the Shield once traffic on `/settings/traffic` has been quiet for a while.

## The Shield

| State | What it does |
| --- | --- |
| Open | No budget on anonymous readers or crawlers. |
| Ceiling | The default. Anonymous readers and crawlers can read until they use up a per-minute budget, then wait. |
| Sign-in only | Anonymous visitors asking for file, commit, blame or diff pages get a short "please sign in" page (status 503). |

Signed-in people and tokens are never affected. The state survives a restart, and each change is recorded as a `shield.changed` event with who made it.

**In the browser:** Settings → Security, press the state you want. **Undo** returns to the previous state.

**With curl,** using an admin-scope token. Paste it at the hidden prompt, and replace `https://your-forge` with the forge's address:

```sh
read -rs FORGE_TOKEN    # paste the token, press Enter; nothing is shown

# See the state
printf 'authorization: Bearer %s\n' "$FORGE_TOKEN" | curl -sS -H @- https://your-forge/api/v1/admin/shield

# Turn it on
printf 'authorization: Bearer %s\n' "$FORGE_TOKEN" | curl -sS -H @- -X PUT \
  -H 'content-type: application/json' -d '{"state":"signin"}' https://your-forge/api/v1/admin/shield

# Back to the default
printf 'authorization: Bearer %s\n' "$FORGE_TOKEN" | curl -sS -H @- -X PUT \
  -H 'content-type: application/json' -d '{"state":"ceiling"}' https://your-forge/api/v1/admin/shield

unset FORGE_TOKEN
```

## A token leaked

Do this first, then work out how it leaked. For every kind: **make the new one, swap it in, delete the old one.** If it's being abused right now, delete the old one first and accept the short break.

| What leaked | Where to replace it |
| --- | --- |
| Your own forge token | `/settings/tokens`: create a new one, delete the old one |
| Someone else's forge token | `/settings/accounts`, open the account, delete the token |
| An SSH key | `/settings/keys`: delete it, add a new one |
| A secret the forge holds for you (an API key, for example) | Change it at the service that issued it first, then set the new value on `/settings/secrets` |
| A cloud account's key | `/settings/cloud`: rotate |
| The backup bucket's keys | Change them at the storage provider, then save the new ones on `/settings/backups` and press Test |
| The snapshot passphrase | Set a new `FORGE_SNAPSHOT_PASSPHRASE` where the forge runs, keep it in your safe, then take a backup and run the restore drill on `/settings/backups`. Keep the old one too until the older snapshots have aged out |

Afterwards, check Settings → Security for tokens or keys you don't recognize, and for deleted repositories. Then check `/settings/traffic` for anything strange.

A token in a public place stays leaked even after you remove the post. Always replace it.

## An account looks wrong

1. Open `/settings/accounts` and find the account.
2. **Suspend** it. It stops working at once, and nothing is deleted. **Undo:** Unsuspend on the same page.
3. Delete its tokens and sessions on the same page.
4. On Settings → Security, check whether it's an admin, whether it added tokens or keys, and whether it deleted anything.
5. If it's your own account, change your password and passkey on your account settings, and sign out your other sessions.

## Freeze releases

Stop new versions going out while you look at something.

**On the forge:** `/releases`, the Hold form, with a reason. **Undo:** Lift on the same card.

**On the droplet,** if the forge won't answer. The release timer there won't cut a release while this file exists:

```sh
ssh <you>@<droplet>
touch /var/tmp/forge-release/release-hold
```

**Undo:** remove that file. Its log is `/var/tmp/forge-release/release-tick.log`.

## Roll back

Usually you don't have to. A release that fails to boot falls back by itself to the last version that was ready, and a release that fails its checks after going live is rolled back and held.

To do it by hand:

1. [Freeze releases](#freeze-releases) first, or the next one replaces your rollback.
2. Find the last good version on `/releases`.
3. Set the forge's Deployment to that image **by its version**. Do not use `kubectl rollout undo`: it returns to the Deployment's previous revision, which is not always the last good version.

   ```sh
   kubectl -n "$NS" set image deployment/"$REL" forge=<image>:<good-version>
   kubectl -n "$NS" rollout status deployment/"$REL"
   ```

4. Check that `/api/v1/health` answers with the version you chose. If the platform puts another image back at its next reconcile, change the version it deploys there too.

`docs/ops/ROLL.md` has the full recipe, including what to check before a roll. A roll that can't start the new pod beside the old one takes the forge dark for a moment, so read section 1 and 2 there first if you can.

**Undo:** lift the hold. The next release moves the forge forward again.

## Restore from backup

Read `docs/RECOVERY.md`. It's written for this moment. In short, on a machine with `git`, `bun` and a clone of the forge, with the bucket's settings and `FORGE_SNAPSHOT_PASSPHRASE` set in the environment:

```sh
bun run src/snapshot/restore.ts latest /some/new/empty/dir
FORGE_DATA=/some/new/empty/dir PORT=3999 FORGE_SSH_PORT=0 bun run src/main.ts
```

Check `curl localhost:3999/api/v1/health`, then the home page, then a recent issue. Only then point the real service at that directory. This doesn't touch the running forge until that last step.

Settings → Security shows the age of the last backup and whether the last restore drill passed. If the drill failed or the backup is overdue, fix that before you need it (`/settings/backups`).

## Cloudflare: challenge or Under Attack

Use this when the forge is too busy to answer, or the Shield isn't enough. Cloudflare stops the traffic before it reaches the forge. Sign in at `dash.cloudflare.com` and pick the forge's domain. Menu names can shift a little.

**Challenge suspicious traffic (try this first):**

1. Go to **Security → WAF → Custom rules → Create rule**.
2. Pick the country, address range or user agent that `/settings/traffic` named. To cover deep pages, use "URI Path contains `/blob/`" and add `/raw/`, `/commits`, `/commit/` and `/blame/` with **Or**.
3. Set the action to **Managed Challenge** and deploy.

**Undo:** turn the rule off in the same list.

**Under Attack mode (for when everything is failing):**

1. On the domain's **Overview** page, find **Under Attack Mode** in the quick actions. It may be under **Security → Settings**.
2. Turn it on. Every visitor gets a short browser check.

Under Attack mode also breaks anything that isn't a browser: `git` over HTTPS, API tokens, curl, and webhooks all stop working through Cloudflare. **Undo:** turn it off in the same place, as soon as the traffic has passed.

## Switching the forge's own sign-in on, and the edge off

The forge signs people in itself, with a password, a passkey or a recovery link. The platform edge's sign-in (`signin.edge`) is optional.

**Switch:**

1. Each person adds a passkey at Settings → Passkeys. A browser the edge signed in can do this. The passkey is linked to the same account; no new account is made.
2. Settings → Accounts shows how many accounts sign in without the edge.
3. On Settings → Capacity (`/settings/capacity`), the row "Sign in through the platform edge" has **Dry run**. It lists who would be locked out, and refuses while you would be.
4. Set the row to `off` once the list is empty or accepted.

**Undo:** set the same row back to `on` (**Put back**). A stored value outranks `FORGE_SIGNIN_EDGE`. With curl, using an admin-scope token at the hidden prompt:

```sh
read -rs FORGE_TOKEN    # paste the token, press Enter; nothing is shown
printf 'authorization: Bearer %s\n' "$FORGE_TOKEN" | curl -sS -H @- -X PUT \
  -H 'content-type: application/json' -d '{"value":"on"}' https://your-forge/api/v1/admin/capacity/signin.edge
unset FORGE_TOKEN
```

**Everyone is locked out and the edge is off:** sign in with a password or passkey. If you have neither, use the recovery link at `/recover` if mail is set up. Otherwise, run `bun src/main.ts --first-admin` where the forge runs. While no admin can sign in, it prints a recovery code for one admin (add `--user <name>` if it asks which), good once for 15 minutes, and how to trade it at `POST /api/v1/first-admin/recover` for an expiring admin token. This works whatever `signin.edge` says. Then turn the edge back on from Settings → Capacity.

**One person is locked out:** an admin tells them to use `/recover`, or turns the edge back on (Settings → Capacity) while the person adds a passkey, then runs the dry run again.

## After any of these

Write down what happened, when and what you changed, in an issue on the forge once it's calm. Then check Settings → Security again. Each section shows when it was last checked.
