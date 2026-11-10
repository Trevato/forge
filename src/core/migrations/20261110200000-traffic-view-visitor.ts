// A visitor's views in one day (`flushViews` in `perf/views_store.ts`, the
// VISITOR_DAY_MAX cap) are counted per new visitor on every flush. With only
// `traffic_view_scope_at` that count walks every row of the scope's day, once
// per visitor: a busy minute held the loop for over 100 ms (#11118). This
// index answers it from the visitor's own rows. Additive.
export default `
  CREATE INDEX traffic_view_scope_visitor_at ON traffic_view (scope, visitor, at);
`;
