const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const s = JSON.parse(
  fs.readFileSync(
    fs.readFileSync('/private/tmp/pb23-state-path', 'utf8'),
    'utf8',
  ),
);
const u = new URL(s.testUrl);
if (!/^pb23_test_\d+$/.test(u.pathname.slice(1)))
  throw Error('Isolation guard');
(async () => {
  const p = new PrismaClient({ datasourceUrl: s.testUrl });
  try {
    execFileSync(
      '/Library/PostgreSQL/18/bin/pg_restore',
      ['--list', s.backup],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    console.log(
      'BACKUP',
      JSON.stringify({
        file: s.backup,
        exists: fs.existsSync(s.backup),
        mode: (fs.statSync(s.backup).mode & 0o777).toString(8),
        archiveListValid: true,
      }),
    );
    const migrations = await p.$queryRawUnsafe(
      'SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY started_at',
    );
    console.log(
      'TEST MIGRATIONS',
      JSON.stringify(
        migrations.map((m) => ({
          name: m.migration_name,
          finished: !!m.finished_at,
          rolledBack: !!m.rolled_back_at,
          checksumMatches:
            crypto
              .createHash('sha256')
              .update(
                fs.readFileSync(
                  `prisma/migrations/${m.migration_name}/migration.sql`,
                ),
              )
              .digest('hex') === m.checksum,
        })),
      ),
    );
    console.log(
      'TEST GROUPS',
      JSON.stringify(
        await p.$queryRawUnsafe(
          `SELECT split_part("idempotencyKey",'-',7) AS scenario,status,count(*)::int AS analyses FROM analysis_requests WHERE "userId"='development-user' GROUP BY 1,2 ORDER BY 1,2`,
        ),
      ),
    );
    console.log(
      'DUPLICATE KEYS',
      JSON.stringify(
        await p.$queryRawUnsafe(
          `SELECT count(*)::int AS duplicate_groups FROM (SELECT "userId","idempotencyKey" FROM analysis_requests WHERE "idempotencyKey" IS NOT NULL GROUP BY 1,2 HAVING count(*)>1) d`,
        ),
      ),
    );
    console.log(
      'DUPLICATE MODELS',
      JSON.stringify(
        await p.$queryRawUnsafe(
          `SELECT count(*)::int AS duplicate_groups FROM (SELECT "analysisId",kind FROM analysis_model_results GROUP BY 1,2 HAVING count(*)>1) d`,
        ),
      ),
    );
  } catch (e) {
    console.error('Verification failed', e.code || e.name);
    process.exitCode = 1;
  } finally {
    await p.$disconnect();
  }
})();
