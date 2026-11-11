// Orders (#11138): the client address an order was placed from, so one address cannot hold more than
// its share of pending names. Additive; older rows keep the empty address.
export default `
  ALTER TABLE forge_order ADD COLUMN address TEXT NOT NULL DEFAULT '';
  CREATE INDEX forge_order_address ON forge_order (address, state);
  `;
