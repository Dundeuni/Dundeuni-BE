import { ApiProperty } from '@nestjs/swagger';
import { normalizePhone } from './phone-number-normalization';

const sources = ['TEXT', 'OCR'] as const;
export const MAX_EXTRACTED_PHONE_NUMBERS = 10;

export class ExtractedPhoneNumberDto {
  @ApiProperty({ example: '01012345678' })
  phoneNumber!: string;

  @ApiProperty({ example: '010-1234-5678' })
  displayNumber!: string;

  @ApiProperty({ enum: sources })
  source!: (typeof sources)[number];
}

export function extractPhoneNumbers(
  text: string,
  source: ExtractedPhoneNumberDto['source'],
): ExtractedPhoneNumberDto[] {
  const result: ExtractedPhoneNumberDto[] = [];
  const seen = new Set<string>();
  // Capture a complete compact number or three groups. The shared policy
  // validates the domestic prefix and number length after display formatting is removed.
  const candidates =
    /(?<![\p{N}A-Za-z_+(-])(?:\+82[ \t-]*\d{1,2}|\(0\d{1,2}\)|0\d{1,2})[ \t-]*\d{3,4}[ \t-]*\d{4}(?![\p{N}A-Za-z_]|(?:[ \t]*[-.][ \t]*|[/:])\p{N})/gu;
  for (const match of text.matchAll(candidates)) {
    const offset = match.index;
    const prefix = text.slice(Math.max(0, offset - 48), offset);
    if (
      /\p{N}(?:[ \t]*[-.][ \t]*|[/:])$/u.test(prefix) ||
      /\+\d{1,3}[ \t-]+$/.test(prefix) ||
      /(?:주민(?:등록)?번호|계좌(?:번호)?|카드번호|인증(?:번호|코드)|주문번호|송장번호|운송장(?:번호)?)[ \t]*[:：=]?[ \t]*$/u.test(
        prefix,
      )
    )
      continue;

    let number: string;
    try {
      const domestic = match[0]
        .replace(/[()]/g, '')
        .replace(/^\+82[ \t-]*/, '0');
      number = normalizePhone(domestic);
    } catch {
      continue;
    }
    if (seen.has(number)) continue;
    seen.add(number);
    const areaLength = number.startsWith('02') ? 2 : 3;
    result.push({
      phoneNumber: number,
      displayNumber: `${number.slice(0, areaLength)}-${number.slice(areaLength, -4)}-${number.slice(-4)}`,
      source,
    });
    if (result.length === MAX_EXTRACTED_PHONE_NUMBERS) break;
  }
  return result;
}
