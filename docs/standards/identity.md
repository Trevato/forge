# Identity: the signed headers an app verifies

Version: 1

An app never writes sign-in. A forge that proxies a request for a signed-in
person tells the app who is there, in two headers.

## Wire format

```
x-forge-identity:  <user id>|<username>|<role>|<expiry ms>
x-forge-signature: base64url(HMAC-SHA256(identity-key, <the identity string>))
```

- `role` is `user` (can see the app's repository) or `admin` (can write it).
- `expiry ms` is epoch milliseconds.
- `identity-key` is the app's `FORGE_APP_IDENTITY_KEY`, different for every
  app, the same for its production and previews. The key is never sent.

Known answer: key `k` and identity `1|ada|admin|4102444800000` give the
signature `EqpoKE3zw6x3dJbx61eTw5q83fcfNh2T6yzPw0acyxc`.

No headers means nobody the forge could name.

## A forge must

- drop any `x-forge-identity` / `x-forge-signature` a client sends before it
  adds its own;
- sign only people it has authenticated, for a short expiry.

## An app must

- verify the signature with a constant-time compare and check the expiry is in
  the future, before it believes the identity;
- treat a missing, malformed, expired or mis-signed pair exactly as no headers
  at all (anonymous), never as an error and never as more privilege.

## An app must not

- trust the headers on a path the forge does not proxy;
- log the key or the signature.

Suite: `standards/app.test.ts` (forged, malformed and unsigned headers change
nothing). The suite holds no key, so it cannot show that an app refuses an
expired identity, nor that a forge signs correctly: the known answer above is
for an implementer to check against their own code.
