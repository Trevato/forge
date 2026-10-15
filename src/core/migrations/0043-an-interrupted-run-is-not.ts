// 43 — an interrupted run is not a park (`crew/interrupted.ts`). Park
// notes written for runs the provider's limit, an unreachable API or a
// restart ended were strikes against work nobody attempted; they are
// reworded so they no longer start with the park note and no longer count.
export default `
  UPDATE comment
     SET body = 'Interrupted, not parked: ' || substr(body, 21)
   WHERE body LIKE 'Parked by the crew: %'
     AND (body LIKE '%rate limit%' OR body LIKE '%rate-limit%'
       OR body LIKE '%rate_limit%' OR body LIKE '%session limit%'
       OR body LIKE '%usage limit%' OR body LIKE '%weekly limit%'
       OR body LIKE '%hit your % limit%' OR body LIKE '%overloaded%'
       OR body LIKE '%too many requests%' OR body LIKE '%(api_error)%'
       OR body LIKE '%may use is resting%' OR body LIKE '%resting —%'
       OR body LIKE '%ECONNREFUSED%' OR body LIKE '%ECONNRESET%'
       OR body LIKE '%ENOTFOUND%' OR body LIKE '%ETIMEDOUT%'
       OR body LIKE '%fetch failed%' OR body LIKE '%unable to connect%'
       OR body LIKE '%connection error%' OR body LIKE '%unreachable%'
       OR body LIKE '%without a pull: cancelled'
       OR body LIKE '%interrupted by a restart%');
  `;
