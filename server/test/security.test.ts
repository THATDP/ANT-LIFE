import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeNickname, SessionManager } from '../src/security/session.js';

test('private invite codes and signed reconnect sessions', () => {
  const sessions = new SessionManager('test-session-secret-at-least-32-characters', 'private-colony-code');
  assert.equal(sessions.verifyInvite('private-colony-code'), true);
  assert.equal(sessions.verifyInvite('wrong-code'), false);
  const issued = sessions.issue('player-123', 1_000);
  assert.equal(sessions.verify(issued.token, 1_001), 'player-123');
  assert.equal(sessions.verify(`${issued.token}tampered`, 1_001), null);
  assert.equal(sessions.verify(issued.token, 1_000 + 31 * 24 * 60 * 60 * 1_000), null);
});

test('nicknames accept readable Unicode and reject unsafe or oversized values', () => {
  assert.equal(normalizeNickname('  Formiga   Azul '), 'Formiga Azul');
  assert.equal(normalizeNickname('Formiga 7'), 'Formiga 7');
  assert.equal(normalizeNickname('<script>'), null);
  assert.equal(normalizeNickname('x'), null);
  assert.equal(normalizeNickname('this-name-is-far-too-long'), null);
});
