import { Injectable } from '@nestjs/common';
import { PhoneHistoryDetailDto } from './dto/phone-history-detail.dto';
import { maskPhone, redactPhoneText } from './phone-privacy.policy';

/** Read-only projection. No APICK/provider dependency or risk recomputation. */
@Injectable()
export class PhoneHistoryService {
  project(value: unknown): PhoneHistoryDetailDto {
    const stored: Record<string, unknown> =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return {
      maskedPhoneNumber: maskPhone(stored.phoneNumber),
      riskLevel: ['SAFE', 'CAUTION', 'DANGER', 'UNKNOWN'].includes(
        stored.riskLevel as string,
      )
        ? (stored.riskLevel as string)
        : null,
      reportCount:
        typeof stored.reportCount === 'number' &&
        Number.isSafeInteger(stored.reportCount) &&
        stored.reportCount >= 0 &&
        stored.reportCount <= 2147483647
          ? stored.reportCount
          : null,
      reportCountIsRange:
        typeof stored.reportCountRaw === 'string' &&
        /^\d{1,8}\+?$/.test(stored.reportCountRaw) &&
        Number(stored.reportCountRaw.replace('+', '')) === stored.reportCount
          ? stored.reportCountRaw.endsWith('+')
          : null,
      reasons: Array.isArray(stored.reasons)
        ? stored.reasons.flatMap((reason) => {
            const safe = redactPhoneText(reason);
            return safe === null ? [] : [safe];
          })
        : [],
      analyzedAt:
        stored.analyzedAt instanceof Date &&
        Number.isFinite(stored.analyzedAt.getTime())
          ? stored.analyzedAt.toISOString()
          : null,
    };
  }
}
