// An issue's newest agent run (the stalled and declined holds, `crew/held.ts`, `crew/autonomy.ts`
// declineOf) read and sorted every agent run on it, up to 880 on the direction issues; the review
// history (`crew/review.ts` reviewAttemptsFor) read every run of each open pull. Each index holds
// what its query reads in the order it reads it: 2.2 ms to 0.0 ms, 2.2 to 0.9, 1.4 to 0.3 on a
// warm copy, and far fewer pages when the cache is cold. Additive.
export default `
  CREATE INDEX IF NOT EXISTS run_agent_issue_latest ON run(issue_id, created_at DESC, id DESC) WHERE kind = 'agent';
  CREATE INDEX IF NOT EXISTS run_review_attempts ON run(issue_id, created_at, id, state, actor_id) WHERE kind = 'agent' AND reason = 'review';
  CREATE INDEX IF NOT EXISTS run_head_checks ON run(issue_id, commit_oid, kind, state, finished_at, created_at);
`;
