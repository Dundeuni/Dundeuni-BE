import { fork, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PNG } from 'pngjs';

const dbDescribe = process.env.PB23_DB_URL ? describe : describe.skip;
dbDescribe('PB-23 isolated PostgreSQL HTTP integration', () => {
  let prisma: PrismaClient;
  const servers: { child: ChildProcess; port: number }[] = [];
  const prefix = `pb23-${randomUUID()}`;
  const image = PNG.sync.write(new PNG({ width: 4, height: 4 }));
  const key = (name: string) => `${prefix}-${name}`;
  const rpc = (
    child: ChildProcess,
    command: string,
    value?: boolean,
  ): Promise<any> =>
    new Promise((resolve) => {
      const id = randomUUID();
      const listener = (msg: any) => {
        if (msg.id === id) {
          child.off('message', listener);
          resolve(msg);
        }
      };
      child.on('message', listener);
      child.send({ id, command, value });
    });
  async function metrics() {
    const rows = await Promise.all(servers.map((s) => rpc(s.child, 'metrics')));
    return rows.reduce(
      (a, b) => ({
        ai: a.ai + b.ai,
        reserve: a.reserve + b.reserve,
        release: a.release + b.release,
        conflicts: a.conflicts + b.conflicts,
      }),
      { ai: 0, reserve: 0, release: 0, conflicts: 0 },
    );
  }
  async function post(name: string, server = 0, bytes = image) {
    const form = new FormData();
    form.append('type', 'IMAGE');
    form.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
      'test.png',
    );
    const response = await fetch(
      `http://127.0.0.1:${servers[server].port}/api/analysis`,
      { method: 'POST', headers: { 'Idempotency-Key': key(name) }, body: form },
    );
    return { status: response.status, body: (await response.json()) as any };
  }
  async function evidence(name: string, expected: number) {
    const rows = await prisma.$queryRawUnsafe<
      { id: string; status: string; modelCount: number }[]
    >(
      'SELECT a.id,a.status,(SELECT count(*)::int FROM analysis_model_results m WHERE m."analysisId"=a.id) AS "modelCount" FROM analysis_requests a WHERE a."userId"=$1 AND a."idempotencyKey"=$2',
      'development-user',
      key(name),
    );
    expect(rows).toHaveLength(expected);
    console.log('SQL evidence', name, JSON.stringify(rows));
    return rows;
  }
  beforeAll(async () => {
    const url = new URL(process.env.PB23_DB_URL!);
    if (
      !/^pb23_test_\d+$/.test(url.pathname.slice(1)) ||
      !['localhost', '127.0.0.1'].includes(url.hostname)
    )
      throw Error('Isolation guard');
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    for (let i = 0; i < 2; i++) {
      const child = fork('scripts/pb23/server.cjs', [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, PB23_DB_URL: url.toString() },
      });
      const port = await new Promise<number>((resolve, reject) => {
        child.once('message', (msg: any) =>
          msg.ready ? resolve(msg.port) : reject(Error('Worker failed')),
        );
        child.once('exit', () => reject(Error('Worker exited')));
      });
      servers.push({ child, port });
    }
  }, 20000);
  afterAll(async () => {
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.child.once('exit', () => resolve());
            s.child.send({ command: 'close' });
          }),
      ),
    );
    await prisma?.$disconnect();
  });
  it('A/B: creates one analysis then reuses exact 202 response across server processes', async () => {
    const before = await metrics();
    const first = await post('reuse');
    expect(first.status).toBe(202);
    const initial = await evidence('reuse', 1);
    expect(initial[0].modelCount).toBe(2);
    const second = await post('reuse', 1);
    expect(second).toEqual(first);
    await evidence('reuse', 1);
    const after = await metrics();
    expect(after.ai - before.ai).toBe(1);
    expect(after.reserve - before.reserve).toBe(1);
  });
  it('C: rejects different bytes with the same key without changing DB', async () => {
    const before = await metrics();
    const original = await prisma.analysis.findFirstOrThrow({
      where: { idempotencyKey: key('reuse') },
    });
    expect(
      (await post('reuse', 1, Buffer.concat([image, Buffer.from([1])]))).status,
    ).toBe(409);
    expect(
      await prisma.analysis.findUnique({ where: { id: original.id } }),
    ).toEqual(original);
    await evidence('reuse', 1);
    const after = await metrics();
    expect(after.ai).toBe(before.ai);
    expect(after.reserve).toBe(before.reserve);
  });
  it('D: allows the same image under a different key', async () => {
    const before = await metrics();
    const response = await post('different');
    expect(response.status).toBe(202);
    const rows = await evidence('different', 1);
    const old = await evidence('reuse', 1);
    expect(rows[0].id).not.toBe(old[0].id);
    const after = await metrics();
    expect(after.ai - before.ai).toBe(1);
    expect(after.reserve - before.reserve).toBe(1);
  });
  it.each([
    ['single', false],
    ['multiprocess', true],
  ] as const)(
    'E: atomically claims 12 concurrent requests (%s)',
    async (name, multi) => {
      const before = await metrics();
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, i) => post(name, multi ? i % 2 : 0)),
      );
      expect(
        responses.filter((r) => r.status === 202).length,
      ).toBeGreaterThanOrEqual(1);
      expect(responses.every((r) => [202, 409].includes(r.status))).toBe(true);
      const rows = await evidence(name, 1);
      expect(rows[0].modelCount).toBe(2);
      const after = await metrics();
      expect(after.ai - before.ai).toBe(1);
      expect(after.reserve - before.reserve).toBe(1);
      expect(after.conflicts - before.conflicts).toBe(11);
      console.log(
        'concurrency',
        name,
        JSON.stringify({
          requests: 12,
          rows: 1,
          ai: after.ai - before.ai,
          reserve: after.reserve - before.reserve,
          uniqueConflictLosers: after.conflicts - before.conflicts,
          statuses: responses.map((r) => r.status),
        }),
      );
    },
  );
  it('F: persists FAILED and replays failure without AI/usage duplication', async () => {
    const before = await metrics();
    await rpc(servers[0].child, 'fail', true);
    try {
      expect((await post('failed')).status).toBe(503);
    } finally {
      await rpc(servers[0].child, 'fail', false);
    }
    const response = await post('failed', 1);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('ANALYSIS503');
    const rows = await evidence('failed', 1);
    expect(rows[0].status).toBe('FAILED');
    expect(rows[0].modelCount).toBe(0);
    const after = await metrics();
    expect(after.ai - before.ai).toBe(1);
    expect(after.reserve - before.reserve).toBe(1);
    expect(after.release - before.release).toBe(1);
  });
  it('G: rejects expired keys without modifying stored analysis or executing AI', async () => {
    await post('expired');
    const original = await prisma.analysis.findFirstOrThrow({
      where: { idempotencyKey: key('expired') },
    });
    const expired = await prisma.analysis.update({
      where: { id: original.id },
      data: { expiresAt: new Date(0) },
    });
    const before = await metrics();
    const response = await post('expired', 1);
    expect(response.status).toBe(409);
    expect(response.body.message).toContain('새 멱등성 키');
    expect(
      await prisma.analysis.findUnique({ where: { id: original.id } }),
    ).toEqual(expired);
    await evidence('expired', 1);
    const after = await metrics();
    expect(after.ai).toBe(before.ai);
    expect(after.reserve).toBe(before.reserve);
  });
});
