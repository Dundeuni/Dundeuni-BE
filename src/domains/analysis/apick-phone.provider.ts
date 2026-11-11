import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../common/http/api-error';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export interface ApickPhoneResult {
  spamType: string | null;
  reportCount: number | null;
  reportCountRaw: string | null;
  reportCountIsRange: boolean;
  cyberCrime: string | null;
  registeredDate: string | null;
  success: number;
  rawData: Record<string, string | number | null>;
}
const unavailable = () =>
  new ApiError(
    503,
    'EXTERNAL_API_UNAVAILABLE',
    '전화번호 조회 서비스를 이용할 수 없습니다.',
  );
@Injectable()
export class ApickPhoneProvider {
  constructor(private readonly http: HttpService) {}
  async analyze(number: string): Promise<ApickPhoneResult> {
    const key = process.env.APICK_AUTH_KEY?.trim();
    if (!key)
      throw new ApiError(
        500,
        'APICK_CONFIGURATION_ERROR',
        'APICK_AUTH_KEY 설정이 필요합니다.',
      );
    try {
      const form = new FormData();
      form.append('number', number);
      const response = await firstValueFrom(
        this.http.post<unknown>(
          'https://apick.app/rest/check_spam_number',
          form,
          {
            headers: { CL_AUTH_KEY: key, Authorization: `Bearer ${key}` },
            timeout: 10000,
            maxRedirects: 0,
            maxContentLength: 65536,
            validateStatus: () => true,
          },
        ),
      );
      const root = object(response.data),
        data = object(root.data),
        api = object(root.api),
        result = object(root.result);
      const errors = [root.error, data.error, result.error].filter(Boolean);
      if (
        response.status === 429 ||
        errors.some(
          (e) =>
            typeof e === 'string' &&
            /포인트.*부족|point.*(?:insufficient|exceed)|quota/i.test(e),
        )
      )
        throw new ApiError(
          503,
          'APICK_QUOTA_EXCEEDED',
          'APICK 포인트 또는 호출 한도를 확인해 주세요.',
        );
      if (response.status === 401 || response.status === 403)
        throw new ApiError(
          503,
          'APICK_AUTHENTICATION_FAILED',
          'APICK 인증 설정을 확인해 주세요.',
        );
      if (
        response.status < 200 ||
        response.status >= 300 ||
        errors.length ||
        api.success !== true ||
        data.success !== 1
      )
        throw unavailable();
      const text = (field: string) => {
        const value = data[field];
        if (value == null) return null;
        if (typeof value !== 'string' || value.length > 2000)
          throw unavailable();
        // Provider fields may unexpectedly contain the input number. Never persist it.
        return value.replace(/\d(?:[\s-]*\d){8,}/g, '[REDACTED]');
      };
      const spamType = text('spam'),
        cyberCrime = text('cyber_crime'),
        registeredDate = text('registed_date');
      const count = data.spam_count;
      if (
        count != null &&
        typeof count !== 'string' &&
        typeof count !== 'number'
      )
        throw unavailable();
      const raw = count == null ? null : String(count);
      if (raw !== null && !/^\d+\+?$/.test(raw)) throw unavailable();
      const reportCount = raw === null ? null : Number(raw.replace('+', ''));
      if (
        reportCount !== null &&
        (!Number.isSafeInteger(reportCount) || reportCount > 2147483647)
      )
        throw unavailable();
      return {
        spamType,
        cyberCrime,
        registeredDate,
        reportCount,
        reportCountRaw: raw,
        reportCountIsRange: raw?.endsWith('+') ?? false,
        success: 1,
        rawData: {
          spam: spamType,
          spam_count: count ?? null,
          cyber_crime: cyberCrime,
          registed_date: registeredDate,
          success: 1,
        },
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  }
}
