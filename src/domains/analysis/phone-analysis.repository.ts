import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ApickPhoneResult } from './apick-phone.provider';
import { PhoneRiskService } from './phone-risk.service';

@Injectable()
export class PhoneAnalysisRepository {
  constructor(private readonly prisma: PrismaService) {}
  create(userId: string, maskedPhone: string) {
    return this.prisma.analysis.create({
      data: {
        userId,
        type: 'PHONE',
        status: 'ANALYZING',
        // Random request identifier; never store an enumerable phone hash.
        requestHash: randomUUID(),
        expiresAt: new Date(Date.now() + 30 * 86400000),
        phoneResult: {
          create: { phoneNumber: maskedPhone, provider: 'APICK' },
        },
      },
    });
  }
  complete(
    id: string,
    data: ApickPhoneResult,
    risk: ReturnType<PhoneRiskService['assess']>,
  ) {
    const analyzedAt = new Date();
    const { rawData, ...normalizedData } = data;
    return this.prisma.analysis.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        completedAt: analyzedAt,
        phoneResult: {
          update: {
            riskLevel: risk.riskLevel,
            reasons: risk.reasons,
            policyVersion: risk.policyVersion,
            spamType: data.spamType,
            reportCount: data.reportCount,
            reportCountRaw: data.reportCountRaw,
            cyberCrime: data.cyberCrime,
            analyzedAt,
            rawData: rawData as Prisma.InputJsonValue,
            normalizedData: normalizedData as unknown as Prisma.InputJsonValue,
          },
        },
      },
    });
  }
  fail(id: string, errorCode: string) {
    return this.prisma.analysis.update({
      where: { id },
      data: { status: 'FAILED', errorCode, completedAt: new Date() },
    });
  }
}
