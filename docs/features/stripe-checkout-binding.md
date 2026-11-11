# Stripe checkout binding

`POST /hooks/stripe` (signed, see `src/http/stripe_hook.ts`) acts on
`checkout.session.completed` through `src/billing/checkout_completed.ts`.

The session must set `metadata.forge` to the name of a forge this forge made,
and may set `metadata.plan` to a plan size. It binds only when `mode` is
`subscription` and `payment_status` is `paid` or `no_payment_required`, and
`customer` and `subscription` are Stripe ids. Then the forge's entitlement is
`active`, provider `stripe`, source `stripe`, with both ids stored, and the
change is kept in `entitlement_change`.

Anything else (unknown forge, unpaid, another mode, malformed fields) is
recorded in `stripe_event` and changes nothing. The event id and the binding
are one transaction: if binding fails the answer is an error and Stripe's retry binds.

To try it: seal a signing secret, POST a signed event, and read the forge's
plan in the admin billing view.
