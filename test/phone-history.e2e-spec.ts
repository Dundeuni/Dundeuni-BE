import { PhoneHistoryService } from '../src/domains/analysis/phone-history.service';
import { maskPhone } from '../src/domains/analysis/phone-privacy.policy';

const project = (value: unknown) => new PhoneHistoryService().project(value);
describe('PHONE history privacy projection', () => {
  it.each([
    ['01012345678', '010********'],
    ['010-1234-5678', '010********'],
    ['02-123-4567', '02*******'],
    ['0212345678', '02********'],
    ['0311234567', '031*******'],
    ['07012345678', '070********'],
    ['010********', '010********'],
    ['02-****-****', '02********'],
    ['010-****-5678', null],
    ['unknown 01012345678', null],
    [null, null],
    ['***', null],
  ])('masks legacy or stored value %s', (value, expected) => {
    expect(maskPhone(value)).toBe(expected);
    expect(project({ phoneNumber: value }).maskedPhoneNumber).toBe(expected);
  });
  it('returns stored values and drops all provider private fields', () => {
    const result = project({
      phoneNumber: '01012345678',
      riskLevel: 'DANGER',
      reportCount: 1000,
      reportCountRaw: '1000+',
      analyzedAt: new Date('2026-11-22T00:00:00Z'),
      reasons: ['저장된 판단 근거'],
      rawData: { number: '01012345678', secret: 'private' },
      normalizedData: { text: 'private' },
    });
    expect(result).toEqual({
      maskedPhoneNumber: '010********',
      riskLevel: 'DANGER',
      reportCount: 1000,
      reportCountIsRange: true,
      analyzedAt: '2026-11-22T00:00:00.000Z',
      reasons: ['저장된 판단 근거'],
    });
  });
  it.each([-1, 1.5, NaN, Infinity, 2147483648, '01012345678', null])(
    'does not invent invalid counts %s',
    (reportCount) => {
      expect(project({ reportCount }).reportCount).toBeNull();
    },
  );
  it.each(['SAFE', 'CAUTION', 'DANGER', 'UNKNOWN'])(
    'preserves saved risk %s without assessing again',
    (riskLevel) => {
      expect(project({ riskLevel, reportCount: 0 }).riskLevel).toBe(riskLevel);
    },
  );
  it('redacts legacy reasons and ignores unknown values', () => {
    const result = project({
      phoneNumber: 'raw',
      riskLevel: '01012345678',
      reasons: [
        '01012345678',
        '02-1234-5678',
        '+82 (10) 1234 5678',
        123,
        { number: '01012345678' },
        '저장된 근거',
      ],
      reportCountRaw: '01012345678',
      analyzedAt: new Date(NaN),
    });
    expect(JSON.stringify(result)).not.toMatch(/01012345678|1234|5678/);
    expect(result).toMatchObject({
      maskedPhoneNumber: null,
      riskLevel: null,
      reportCount: null,
      reportCountIsRange: null,
      analyzedAt: null,
      reasons: ['[REDACTED]', '[REDACTED]', '+[REDACTED]', '저장된 근거'],
    });
  });
  it.each([null, [], {}, 'bad'])(
    'handles missing/failed stored result %s',
    (value) => {
      expect(project(value)).toEqual({
        maskedPhoneNumber: null,
        riskLevel: null,
        reportCount: null,
        reportCountIsRange: null,
        analyzedAt: null,
        reasons: [],
      });
    },
  );
});
