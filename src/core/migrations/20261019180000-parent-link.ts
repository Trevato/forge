// A sign-in begun by a signed-in person to link their parent-forge identity
// (#2906): the round trip remembers whose account it is for, so the callback
// links that account and never makes one.
export default `
  ALTER TABLE rp_login ADD COLUMN link_user TEXT;
  `;
