import { ApiError } from '../../common/http/api-error';

/** The domestic number policy used by the #19 APICK endpoint. */
export function normalizePhone(value: unknown): string {
  if (typeof value === 'string' && value.length <= 64) {
    const number = value.replace(/[\s-]/g, '');
    if (
      /^(?:010\d{8}|01[16789]\d{7,8}|02\d{7,8}|0(?:3[1-3]|4[1-4]|5[1-5]|6[1-4])\d{7,8}|070\d{8})$/.test(
        number,
      )
    ) {
      return number;
    }
  }
  throw new ApiError(
    400,
    'INVALID_PHONE_NUMBER',
    '유효한 한국 전화번호를 입력해 주세요.',
  );
}
