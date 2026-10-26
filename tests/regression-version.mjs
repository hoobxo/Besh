import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('../db/migrations/0001_init.sql', import.meta.url), 'utf8'));
sql.prepare('INSERT INTO servers(id,name,host,port,username,auth_method,credential,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('s1', 'original', 'example.com', 22, 'root', 'password', '{}', 0, 0);
const db = {
  prepare(query) {
    let values = [];
    return {
      bind(...v) { values = v; return this; },
      async first() { return sql.prepare(query).get(...values) || null; },
      async run() { const r = sql.prepare(query).run(...values); return { meta: { changes: r.changes } }; },
    };
  },
};
import { updateServer } from '../apps/worker/src/domain/server-store.ts';
const common = { host: 'example.com', port: 22, username: 'root', authMethod: 'password', groupId: null, expectedVersion: 1, now: 1 };
const results = await Promise.allSettled([
  updateServer(db, 's1', { ...common, name: 'edit-A' }),
  updateServer(db, 's1', { ...common, name: 'edit-B' }),
]);
assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
const failed = results.find(x => x.status === 'rejected');
assert.match(failed.reason.message, /changed elsewhere/);
assert.equal(sql.prepare('SELECT version FROM servers').get().version, 2);
console.log('PASS: exactly one concurrent edit succeeds; the stale edit is rejected');
