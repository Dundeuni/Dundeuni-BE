import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export const ANALYSIS_EXPIRY_BATCH_SIZE = 500;

@Injectable()
export class AnalysisExpiryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Global maintenance, never exposed as a user API. One atomic bounded deletion.
   * SKIP LOCKED lets other instances process different rows and avoids waiting on live writes.
   * The final expiry predicate also protects records whose retention was extended concurrently.
   */
  deleteExpiredBatch(now: Date): Promise<number> {
    // Prisma DateTime uses UTC values in TIMESTAMP(3) WITHOUT TIME ZONE columns.
    // Raw Date parameters are timestamptz, so convert them explicitly before comparison.
    return this.prisma.$executeRaw`
      WITH expired AS (
        SELECT id FROM "analysis_requests"
        WHERE "expiresAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "expiresAt", id
        LIMIT ${ANALYSIS_EXPIRY_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "analysis_requests" a USING expired e
      WHERE a.id = e.id AND a."expiresAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')`;
  }
}
