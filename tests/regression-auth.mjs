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
import { handleUpdateServer } from '../apps/worker/src/http/servers.ts';
const before = sql.prepare('SELECT auth_method, credential FROM servers').get();
const response = await handleUpdateServer(
  new Request('https://besh.test/api/servers/s1', {
    method: 'PUT',
    body: JSON.stringify({ name: 'changed', host: 'example.com', port: 22, username: 'root', authMethod: 'publickey', credential: '', version: 1 }),
  }),
  { DB: db, CREDENTIAL_KEY: Buffer.alloc(32).toString('base64') },
  's1',
  { resolve: async () => ['93.184.216.34'] },
);
assert.equal(response.status, 400);
assert.match((await response.json()).error.message, /new credential/);
assert.deepEqual(sql.prepare('SELECT auth_method, credential FROM servers').get(), before);
console.log('PASS: switching authentication without a replacement credential is rejected');
