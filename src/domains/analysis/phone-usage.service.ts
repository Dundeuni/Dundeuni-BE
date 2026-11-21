import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiError } from '../../common/http/api-error';

@Injectable()
export class PhoneUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  async reserve(userId: string): Promise<void> {
    const limit = Number(this.config.get<string>('PHONE_DAILY_LIMIT') ?? 10);
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new ApiError(
        500,
        'INTERNAL_SERVER_ERROR',
        '전화번호 조회 한도 설정이 올바르지 않습니다.',
      );
    const day = new Date().toISOString().slice(0, 10);
    // One atomic upsert serializes reservations across all application instances.
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "phone_daily_usage" ("userId", "day", "count")
      VALUES (${userId}, ${day}, 1)
      ON CONFLICT ("userId", "day") DO UPDATE
      SET "count" = "phone_daily_usage"."count" + 1
      WHERE "phone_daily_usage"."count" < ${limit}
      RETURNING "count"`;
    if (!rows.length)
      throw new ApiError(
        429,
        'USAGE429',
        '일일 전화번호 분석 이용 한도를 초과했습니다.',
      );
  }
}
