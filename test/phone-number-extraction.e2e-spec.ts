import { extractPhoneNumbers } from '../src/domains/analysis/phone-number-extraction.service';
import { normalizePhone } from '../src/domains/analysis/phone-number-normalization';

describe('domestic phone candidates', () => {
  it.each([
    ['010-1234-5678', '01012345678'],
    ['01012345678', '01012345678'],
    ['010 1234 5678', '01012345678'],
    ['+82 10-1234-5678', '01012345678'],
    ['(02) 123-4567', '021234567'],
    ['031-123-4567', '0311234567'],
    ['070-1234-5678', '07012345678'],
    ['011-123-4567', '0111234567'],
  ])('normalizes %s for the existing phone API', (input, expected) => {
    const items = extractPhoneNumbers(`연락: ${input}로 문의`, 'TEXT');
    expect(items).toHaveLength(1);
    expect(items[0].phoneNumber).toBe(expected);
    expect(normalizePhone(items[0].displayNumber)).toBe(expected);
  });

  it.each([
    '',
    '전화번호가 없는 문자',
    '1588-1234, 0507-1234-5678, +1-010-1234-5678, +1 (010) 1234-5678',
    '2026-11-25 14:05:00',
    '00101012345678999 ０01012345678',
    '카드 1234-010-1234-5678-9999',
    '900101-1012345, 인증번호 01012345678, 계좌번호: 010-1234-5678',
    '송장번호 01012345678, 주문번호 01098765432',
    'O10-1234-5678, 010-12O4-5678, 010-1234-567O',
  ])('ignores invalid or non-phone input %j', (input) => {
    expect(extractPhoneNumbers(input, 'OCR')).toEqual([]);
  });

  it('accepts a spaced slash between complete phone numbers', () => {
    expect(
      extractPhoneNumbers('01012345678 / 02-123-4567', 'TEXT').map(
        ({ phoneNumber }) => phoneNumber,
      ),
    ).toEqual(['01012345678', '021234567']);
  });

  it('preserves order and source, deduplicating before limiting to ten', () => {
    const numbers = Array.from(
      { length: 12 },
      (_, i) => `0101234${String(5600 + i)}`,
    );
    const input = ['02-123-4567', '+82 2 123 4567', ...numbers].join(', ');
    expect(extractPhoneNumbers(input, 'OCR')).toEqual([
      { phoneNumber: '021234567', displayNumber: '02-123-4567', source: 'OCR' },
      ...numbers.slice(0, 9).map((phoneNumber) => ({
        phoneNumber,
        displayNumber: `010-1234-${phoneNumber.slice(-4)}`,
        source: 'OCR',
      })),
    ]);
  });
});
