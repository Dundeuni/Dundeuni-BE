const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const state = JSON.parse(
  fs.readFileSync(
    fs.readFileSync('/private/tmp/pb23-state-path', 'utf8'),
    'utf8',
  ),
);
const url = new URL(state.testUrl);
if (
  !/^pb23_test_\d+$/.test(url.pathname.slice(1)) ||
  !['localhost', '127.0.0.1'].includes(url.hostname)
)
  throw Error('Isolation guard');
const run = (args, env) => {
  const r = spawnSync('node', ['node_modules/prisma/build/index.js', ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error('Prisma command failed', args[0], args[1]);
    process.exit(1);
  }
  console.log(
    r.stdout
      .replace(/Datasource .*\n/g, '')
      .replace(/Environment variables.*\n/g, ''),
  );
};
(async () => {
  let p;
  try {
    console.log('EXISTING DB DIFF (read-only):');
    run(
      [
        'migrate',
        'diff',
        '--from-schema-datasource',
        'prisma/schema.prisma',
        '--to-schema-datamodel',
        'prisma/schema.prisma',
        '--script',
      ],
      {},
    );
    const staged = `${state.dir}/baseline`;
    fs.mkdirSync(`${staged}/migrations`, { recursive: true });
    fs.copyFileSync('prisma/schema.prisma', `${staged}/schema.prisma`);
    fs.copyFileSync(
      'prisma/migrations/migration_lock.toml',
      `${staged}/migrations/migration_lock.toml`,
    );
    for (const name of fs
      .readdirSync('prisma/migrations')
      .filter((x) => /^\d/.test(x) && x < '20261019000000'))
      fs.cpSync(`prisma/migrations/${name}`, `${staged}/migrations/${name}`, {
        recursive: true,
      });
    run(['migrate', 'deploy', '--schema', `${staged}/schema.prisma`], {
      DATABASE_URL: state.testUrl,
    });
    p = new PrismaClient({ datasourceUrl: state.testUrl });
    await p.$executeRawUnsafe(
      `INSERT INTO analysis_requests (id,"userId",type,"requestHash","expiresAt") VALUES ('00000000-0000-4000-8000-000000000023','pb23-baseline','IMAGE','baseline',CURRENT_TIMESTAMP + interval '1 day')`,
    );
    run(['migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
      DATABASE_URL: state.testUrl,
    });
    run(
      [
        'migrate',
        'diff',
        '--from-schema-datasource',
        'prisma/schema.prisma',
        '--to-schema-datamodel',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      { DATABASE_URL: state.testUrl },
    );
    console.log(
      'COLUMN',
      JSON.stringify(
        await p.$queryRawUnsafe(
          `SELECT column_name,data_type,character_maximum_length,is_nullable FROM information_schema.columns WHERE table_name='analysis_requests' AND column_name='idempotencyKey'`,
        ),
      ),
    );
    console.log(
      'INDEXES',
      JSON.stringify(
        await p.$queryRawUnsafe(
          `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('analysis_requests','analysis_model_results') ORDER BY indexname`,
        ),
      ),
    );
    console.log(
      'FK',
      JSON.stringify(
        await p.$queryRawUnsafe(
          `SELECT conname FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace`,
        ),
      ),
    );
    console.log(
      'BASELINE',
      JSON.stringify(
        await p.analysis.findUnique({
          where: { id: '00000000-0000-4000-8000-000000000023' },
          select: { id: true, idempotencyKey: true, requestHash: true },
        }),
      ),
    );
  } catch (e) {
    console.error('Migration verification failed:', e.code || e.name);
    process.exitCode = 1;
  } finally {
    if (p) await p.$disconnect();
  }
})();
