// Anonymous spawns counted on disk (#3014): the daily caps survive a restart.
export default `
  CREATE TABLE anon_spawn (
    bucket TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX anon_spawn_at ON anon_spawn (at);
  `;
