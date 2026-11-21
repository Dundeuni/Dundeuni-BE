import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PhoneUsageService } from '../src/domains/analysis/phone-usage.service';
import { PrismaService } from '../src/prisma/prisma.service';
const dbDescribe = process.env.PHONE_DB_URL ? describe : describe.skip;
dbDescribe('paid phone quota in isolated PostgreSQL', () => {
  let prisma: PrismaClient;
  beforeAll(async () => {
    const url = new URL(process.env.PHONE_DB_URL!);
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !/^pb23_test_\d+$/.test(url.pathname.slice(1))
    )
      throw Error('isolated DB required');
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
  });
  afterAll(async () => prisma?.$disconnect());
  it('enforces one shared daily limit under concurrent requests from separate instances', async () => {
    const user = `phone-${randomUUID()}`;
    const config = new ConfigService({ PHONE_DAILY_LIMIT: '3' });
    const services = [
      new PhoneUsageService(prisma as PrismaService, config),
      new PhoneUsageService(prisma as PrismaService, config),
    ];
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => services[i % 2].reserve(user)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const failures = results.filter(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult[];
    expect(failures.every((r) => r.reason.getStatus() === 429)).toBe(true);
    const rows = await prisma.phoneDailyUsage.findMany({
      where: { userId: user },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
    await expect(
      services[0].reserve(`other-${randomUUID()}`),
    ).resolves.toBeUndefined();
  });
});
