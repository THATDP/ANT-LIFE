import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, originAllowed } from '../src/config.js';

const secret = 'test-only-secret-with-at-least-32-characters';

test('production config refuses missing database or invite-only security settings', () => {
  const common = {
    NODE_ENV: 'production',
    INVITE_CODE: 'private-invite-code',
    SESSION_SECRET: secret,
    ALLOWED_ORIGINS: 'https://ant-life.example',
  };
  assert.throws(() => loadConfig(common), /DATABASE_URL/);
  const config = loadConfig({ ...common, DATABASE_URL: 'postgresql://unused:unused@localhost/antlife' });
  assert.equal(config.production, true);
  assert.equal(config.databaseUrl, 'postgresql://unused:unused@localhost/antlife');
  assert.equal(config.inviteCode, 'private-invite-code');
  assert.equal(originAllowed('https://ant-life.example', config), true);
  assert.equal(originAllowed('https://attacker.example', config), false);
  assert.equal(originAllowed(undefined, config), false);
});

test('development config has a local invite and local-file persistence by default', () => {
  const config = loadConfig({ NODE_ENV: 'development' });
  assert.equal(config.production, false);
  assert.equal(config.inviteCode, 'ANT-LIFE-LOCAL');
  assert.equal(config.databaseUrl, undefined);
  assert.equal(config.localSavePath, '.local/colony.json');
  assert.equal(originAllowed('http://localhost:5173', config), true);
});
