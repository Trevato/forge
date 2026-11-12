// Finding a conversation by its title or the words in its turns (#8823). One
// FTS5 table holds a row per standing turn and one per non-empty title; the
// triggers keep it in step with every write, including the cascade that removes
// a person's conversations and the prune that keeps a conversation's newest
// turns, so no code path has to remember it. A turn set aside (replaced) is
// left out. The owner is an indexed column, so a search puts it in the MATCH and
// the engine's own limit applies to the person's rows alone. Deletes are keyed by
// rowid, never by the UNINDEXED columns (that would scan every person's rows): a
// turn's row is 2 * the turn's rowid, a title's is 2 * the conversation's rowid + 1,
// so every trigger writes in O(1). New table and triggers only; the turns already
// stored are indexed here.
export default `
  CREATE VIRTUAL TABLE conversation_find USING fts5(
    text,
    user_id,
    conversation_id UNINDEXED,
    turn_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  INSERT INTO conversation_find (rowid, text, user_id, conversation_id, turn_id)
    SELECT t.rowid * 2, t.text, c.user_id, t.conversation_id, t.id
      FROM conversation_turn t JOIN conversation c ON c.id = t.conversation_id
     WHERE t.replaced_at IS NULL AND t.role IN ('person', 'agent');
  INSERT INTO conversation_find (rowid, text, user_id, conversation_id, turn_id)
    SELECT rowid * 2 + 1, title, user_id, id, '' FROM conversation WHERE title <> '';
  CREATE TRIGGER conversation_find_turn_add AFTER INSERT ON conversation_turn
  WHEN new.replaced_at IS NULL AND new.role IN ('person', 'agent')
  BEGIN
    INSERT INTO conversation_find (rowid, text, user_id, conversation_id, turn_id)
      SELECT new.rowid * 2, new.text, user_id, new.conversation_id, new.id FROM conversation WHERE id = new.conversation_id;
  END;
  CREATE TRIGGER conversation_find_turn_drop AFTER DELETE ON conversation_turn
  BEGIN
    DELETE FROM conversation_find WHERE rowid = old.rowid * 2;
  END;
  CREATE TRIGGER conversation_find_turn_aside AFTER UPDATE OF replaced_at ON conversation_turn
  WHEN new.replaced_at IS NOT NULL
  BEGIN
    DELETE FROM conversation_find WHERE rowid = old.rowid * 2;
  END;
  CREATE TRIGGER conversation_find_turn_back AFTER UPDATE OF replaced_at ON conversation_turn
  WHEN new.replaced_at IS NULL AND old.replaced_at IS NOT NULL AND new.role IN ('person', 'agent')
  BEGIN
    INSERT INTO conversation_find (rowid, text, user_id, conversation_id, turn_id)
      SELECT new.rowid * 2, new.text, user_id, new.conversation_id, new.id FROM conversation WHERE id = new.conversation_id;
  END;
  CREATE TRIGGER conversation_find_title AFTER UPDATE OF title ON conversation
  BEGIN
    DELETE FROM conversation_find WHERE rowid = old.rowid * 2 + 1;
    INSERT INTO conversation_find (rowid, text, user_id, conversation_id, turn_id)
      SELECT new.rowid * 2 + 1, new.title, new.user_id, new.id, '' WHERE new.title <> '';
  END;
  CREATE TRIGGER conversation_find_gone AFTER DELETE ON conversation
  BEGIN
    DELETE FROM conversation_find WHERE rowid = old.rowid * 2 + 1;
  END;
  `;
