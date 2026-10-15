// 61 — an agent never owns an organization (#722, CLAUDE.md invariant 10):
// every agent on a team that confers admin is taken off it, and each
// removal is told on the outbox as \`team.member_removed\` with its reason.
// The event id is a ULID made here — the time now, then randomness — so
// it sorts after every event before it, as \`kernel/id.ts\` would make it.
export default `
  WITH a(c) AS (SELECT '0123456789abcdefghjkmnpqrstvwxyz'),
       n(ms) AS (SELECT CAST(round((julianday('now') - 2440587.5) * 86400000) AS INTEGER)),
       gone AS (
         SELECT t.id AS team_id, u.id AS user_id, u.username AS user, o.username AS org
           FROM team_member m
           JOIN team t ON t.id = m.team_id
           JOIN user u ON u.id = m.user_id
           JOIN user o ON o.id = t.org_id
          WHERE t.permission = 'admin' AND u.is_agent = 1
       )
  INSERT INTO event (id, kind, payload)
  SELECT substr(a.c, ((n.ms >> 45) & 31) + 1, 1) || substr(a.c, ((n.ms >> 40) & 31) + 1, 1) || substr(a.c, ((n.ms >> 35) & 31) + 1, 1) || substr(a.c, ((n.ms >> 30) & 31) + 1, 1) || substr(a.c, ((n.ms >> 25) & 31) + 1, 1) || substr(a.c, ((n.ms >> 20) & 31) + 1, 1) || substr(a.c, ((n.ms >> 15) & 31) + 1, 1) || substr(a.c, ((n.ms >> 10) & 31) + 1, 1) || substr(a.c, ((n.ms >> 5) & 31) + 1, 1) || substr(a.c, ((n.ms >> 0) & 31) + 1, 1)
         || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1) || substr(a.c, (abs(random()) % 32) + 1, 1),
         'team.member_removed',
         json_object('org', g.org, 'teamId', g.team_id, 'user', g.user,
                     'why', 'an agent never owns an organization (#722)')
    FROM gone g, a, n;
  DELETE FROM team_member
   WHERE (team_id, user_id) IN (
     SELECT m.team_id, m.user_id FROM team_member m
       JOIN team t ON t.id = m.team_id JOIN user u ON u.id = m.user_id
      WHERE t.permission = 'admin' AND u.is_agent = 1);
  `;
