const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { parse } = require('dotenv');
const { PrismaClient } = require('@prisma/client');
const c = parse(fs.readFileSync('.env'));
const u = new URL(c.DATABASE_URL);
(async () => {
  let p;
  try {
    if (
      c.NODE_ENV !== 'development' ||
      !['localhost', '127.0.0.1'].includes(u.hostname) ||
      u.pathname !== '/dundeuni'
    )
      throw Error('Development database guard failed');
    const dir = fs.mkdtempSync('/private/tmp/pb23-');
    fs.chmodSync(dir, 0o700);
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(u.password) };
    const args = [
      '-h',
      u.hostname,
      '-p',
      u.port || '5432',
      '-U',
      decodeURIComponent(u.username),
    ];
    const backup = `${dir}/existing.dump`;
    execFileSync(
      '/Library/PostgreSQL/18/bin/pg_dump',
      [...args, '-Fc', '-f', backup, u.pathname.slice(1)],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    fs.chmodSync(backup, 0o600);
    const db = `pb23_test_${Date.now()}`;
    p = new PrismaClient({ datasourceUrl: u.toString() });
    await p.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    const test = new URL(u);
    test.pathname = `/${db}`;
    test.searchParams.set('schema', 'public');
    const state = { dir, backup, database: db, testUrl: test.toString() };
    fs.writeFileSync(`${dir}/state.json`, JSON.stringify(state), {
      mode: 0o600,
    });
    fs.writeFileSync('/private/tmp/pb23-state-path', `${dir}/state.json`, {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        backup,
        backupExists: fs.statSync(backup).size > 0,
        permissions: 'directory 0700, files 0600',
        testDatabase: db,
        statePath: `${dir}/state.json`,
      }),
    );
  } catch (e) {
    console.error('Prepare failed:', e.code || e.name);
    process.exitCode = 1;
  } finally {
    if (p) await p.$disconnect();
  }
})();
