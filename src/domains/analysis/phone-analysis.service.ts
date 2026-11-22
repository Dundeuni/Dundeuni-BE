import { maskPhone } from './phone-privacy.policy';
import { PhoneUsageService } from './phone-usage.service';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/http/api-error';
import { ApickPhoneProvider } from './apick-phone.provider';
import { PhoneAnalysisRepository } from './phone-analysis.repository';
import { normalizePhone, PhoneAnalysisResponseDto } from './phone-analysis.dto';
import { PhoneRiskService } from './phone-risk.service';

@Injectable()
export class PhoneAnalysisService {
  constructor(
    private readonly repository: PhoneAnalysisRepository,
    private readonly provider: ApickPhoneProvider,
    private readonly risk: PhoneRiskService,
    private readonly usage: PhoneUsageService,
  ) {}
  async create(
    userId: string,
    input: unknown,
  ): Promise<PhoneAnalysisResponseDto> {
    const number = normalizePhone(input);
    let id: string | undefined;
    try {
      const row = await this.repository.create(userId, maskPhone(number)!);
      id = row.id;
      // Charge every attempted paid lookup, including uncertain upstream failures; no automatic retry.
      await this.usage.reserve(userId);
      const data = await this.provider.analyze(number);
      await this.repository.complete(id, data, this.risk.assess(data));
      return { analysisId: id, status: 'COMPLETED' };
    } catch (error) {
      const safeError =
        error instanceof ApiError
          ? error
          : new ApiError(
              500,
              'INTERNAL_SERVER_ERROR',
              '전화번호 분석 결과를 저장할 수 없습니다.',
            );
      if (id) {
        try {
          await this.repository.fail(
            id,
            (safeError.getResponse() as { code: string }).code,
          );
        } catch {
          throw new ApiError(
            500,
            'INTERNAL_SERVER_ERROR',
            '전화번호 분석 실패 상태를 저장할 수 없습니다.',
          );
        }
      }
      throw safeError;
    }
  }
}
