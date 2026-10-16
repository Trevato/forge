// Only a person's close or comment keeps a setting (#2029). A kept row made
// by an agent's close (the planner closed the `cells.egress` finding, #2021)
// is taken back, so the owner is asked again. A row whose finding was last
// closed by a person, or that a person commented on after the value was set,
// stays.
export default `
  DELETE FROM sentinel_kept
   WHERE EXISTS (
       SELECT 1 FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id
        WHERE t.key = sentinel_kept.key AND i.state = 'closed')
     AND NOT EXISTS (
       SELECT 1 FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id
        WHERE t.key = sentinel_kept.key
          AND ((SELECT e.actor_id FROM event e
                 WHERE e.kind = 'issue.closed' AND e.repo_id = i.repo_id
                   AND json_extract(e.payload, '$.number') = i.number
                 ORDER BY e.id DESC LIMIT 1)
                 IN (SELECT id FROM user WHERE is_agent = 0 AND kind = 'user')
               OR EXISTS (SELECT 1 FROM comment c JOIN user u ON u.id = c.author_id
                           WHERE c.issue_id = i.id AND c.created_at >= sentinel_kept.updated_at
                             AND u.is_agent = 0 AND u.kind = 'user')));
  `;
