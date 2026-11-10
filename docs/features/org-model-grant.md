# An org's model account

A new organization has no model account, so its crew runs refuse with
"the account `<org>` has no model grant; an admin can grant one at
/settings/accounts/<org>".

A forge admin grants it there (the "Model budget" card), or with
`POST /api/v1/admin/accounts/<org>/model-grant {"usdPerMonth": 20}` (0 or null
takes it back): dollars a month on the forge's own credential, audited as
`account.model_granted`. The grant is explicit on purpose: membership of an
org's Owners team is the org owners' to change, so it never reaches the forge's
credential, even with a forge admin on it.
