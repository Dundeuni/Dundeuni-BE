const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const state = JSON.parse(
  fs.readFileSync(
    fs.readFileSync('/private/tmp/pb23-state-path', 'utf8'),
    'utf8',
  ),
);
const u = new URL(state.testUrl);
if (
  !/^pb23_test_\d+$/.test(u.pathname.slice(1)) ||
  !['localhost', '127.0.0.1'].includes(u.hostname)
)
  throw Error('Isolation guard');
const result = spawnSync(
  'npm',
  ['test', '--', '--runInBand', ...process.argv.slice(2)],
  {
    env: {
      ...process.env,
      PB23_DB_URL: state.testUrl,
      DATABASE_URL: state.testUrl,
      V1_DB_TEST: '1',
    },
    stdio: 'inherit',
  },
);
process.exitCode = result.status ?? 1;
