import { Injectable } from '@nestjs/common';
import { ApickPhoneResult } from './apick-phone.provider';

export const PHONE_RISK_POLICY = {
  version: 'phone-initial-1',
  dangerousSpamTypes: ['보이스피싱', 'SMS 피싱'],
  // No count threshold establishes fraud. Any positive count warrants caution.
  cautionReportMinimum: 1,
} as const;
export type PhoneRiskLevel = 'SAFE' | 'CAUTION' | 'DANGER' | 'UNKNOWN';
@Injectable()
export class PhoneRiskService {
  assess(data: ApickPhoneResult): {
    riskLevel: PhoneRiskLevel;
    reasons: string[];
    policyVersion: string;
  } {
    let riskLevel: PhoneRiskLevel = 'UNKNOWN';
    const reasons: string[] = [];
    if (
      PHONE_RISK_POLICY.dangerousSpamTypes.some(
        (type) => data.spamType === type,
      )
    ) {
      riskLevel = 'DANGER';
      reasons.push(
        '피싱 유형의 신고 정보가 있습니다. 사기 확정 판정은 아닙니다.',
      );
    } else if (
      (data.reportCount ?? 0) >= PHONE_RISK_POLICY.cautionReportMinimum ||
      data.spamType?.trim()
    ) {
      riskLevel = 'CAUTION';
      reasons.push('스팸 유형 또는 신고 이력이 있어 주의가 필요합니다.');
    }
    if (
      data.cyberCrime &&
      !['<미확인>', '최근 3개월 내 3건 이상 접수된 민원이 없습니다.'].includes(
        data.cyberCrime.trim(),
      )
    ) {
      if (riskLevel === 'UNKNOWN') riskLevel = 'CAUTION';
      reasons.push(
        '사이버 범죄 안내 정보의 별도 확인이 필요합니다. 범죄 여부를 확정하지 않습니다.',
      );
    }
    if (riskLevel === 'UNKNOWN')
      reasons.push(
        '신고 이력이 없거나 판단 정보가 부족합니다. 안전을 보장하지 않습니다.',
      );
    return { riskLevel, reasons, policyVersion: PHONE_RISK_POLICY.version };
  }
}
