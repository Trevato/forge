// Curated packs (#11006): a pack is a named, ordered list of repos on this
// forge that an admin edits in the forge itself, with a pitch and a crew
// brief and a kept history. Additive. The first two, Business and Gamer, are
// seeded with the owner's lists; repos that are missing or not public are
// left out when the page is drawn, and named there.
export default `
  CREATE TABLE curated_pack (
    name TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    pitch TEXT NOT NULL DEFAULT '',
    brief TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE curated_pack_repo (
    pack TEXT NOT NULL REFERENCES curated_pack(name) ON DELETE CASCADE ON UPDATE CASCADE,
    repo TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (pack, repo)
  );
  CREATE TABLE curated_pack_change (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pack TEXT NOT NULL,
    actor TEXT NOT NULL,
    what TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX curated_pack_change_pack ON curated_pack_change (pack, id);
  INSERT INTO curated_pack (name, title, pitch, brief, position, created_at, updated_at) VALUES
    ('business', 'Business', 'Leads, listings, forms and money: the tools a small business runs on.',
     'You work for a small business. Put leads, forms and money first: answer a new lead fast, keep every form working, and keep the deal and payment numbers right. Say plainly what you changed and what a customer would notice.',
     0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ('gamer', 'Gamer', 'Games to play and make yours: a shelf, a sandbox, classics and a shooter engine.',
     'You make games feel good to play. Put play feel and animation first: input that answers on the next frame, motion with weight, sound and feedback on every hit. Say plainly what you changed and how it plays now.',
     1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  INSERT INTO curated_pack_repo (pack, repo, position) VALUES
    ('business','trevato/realty-desk',0),('business','trevato/deal-clock',1),('business','trevato/listing-launch',2),
    ('business','trevato/speed-to-lead',3),('business','trevato/form-engines',4),('business','trevato/business-spawner',5),
    ('business','trevato/bazaar',6),
    ('gamer','trevato/games-shelf',0),('gamer','trevato/sandbox-game',1),('gamer','trevato/pixel-plays',2),
    ('gamer','trevato/scrims',3),('gamer','trevato/chess',4),('gamer','trevato/pong',5),('gamer','trevato/voxel',6),
    ('gamer','trevato/gamers',7),('gamer','trevato/cs-engine',8),('gamer','trevato/survivor-guide',9);
  `;
