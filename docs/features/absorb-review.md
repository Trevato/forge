# Absorb, reviewed from several angles (#9441)

One finding per angle, read from the code at `47c57bd6`. Work that follows is filed as its own issue.

- **Security.** Reach is sound: a declaration alone does nothing, only a non-agent site admin absorbs, readers alone get a menu entry, `/apps/open` re-checks access, `page` is a path on the app's own host, and a forge-owned variable name cannot be set. Two gaps: the menu name and page follow the latest production commit rather than the admin's act (#9541), and deleting an app leaves its feature rows and plain-text settings behind (#9542). Settings readable by repository readers, and by previews, is documented and unchanged.
- **Without the crew.** Nothing quietly needs a model: absorb, settings, redeploy and the menu call no model, and `test/apps-features.test.ts` asserts no run is started with no credential. The crew cannot absorb either (agent accounts are refused), which is intended. No issue.
- **Experience.** Discovery, confirmation and refused-save behaviour are thin, and the menu mixes features among the forge's own links (#9544).
- **Product.** Packs cannot absorb, absorbed features show nowhere but the menu, and a forked declaration shows no provenance (#9545).
- **Speed.** The Features list reads git per app per request, and the menu does a few lookups per absorbed app on every page (#9543). Not measured; no regression at the current two features is claimed.
- **Credit.** Ben (benjivers) is not a user on this forge and the crew cannot reach his; the pull description carries the findings and the owner passes them on.
