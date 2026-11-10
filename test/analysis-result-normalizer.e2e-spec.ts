import {
  normalizeReasons,
  normalizeTexts,
} from '../src/domains/analysis/analysis-result.normalizer';

describe('analysis display text normalization', () => {
  it.each([null, undefined, [], 'invalid'])(
    'normalizes absent text to empty arrays: %s',
    (value) => {
      expect(normalizeReasons(value)).toEqual([]);
      expect(normalizeTexts(value)).toEqual([]);
    },
  );
  it('drops blank/invalid values and deduplicates while preserving order', () => {
    expect(
      normalizeReasons([
        { description: '  첫째\n 근거 ' },
        { description: '첫째 근거', rawScore: 'private' },
        null,
        {},
        { description: 1 },
        { description: ' ' },
        { description: '둘째 근거' },
      ]),
    ).toEqual([{ description: '첫째 근거' }, { description: '둘째 근거' }]);
    expect(normalizeTexts([' 한계 ', null, '', '한계', '다른 한계'])).toEqual([
      '한계',
      '다른 한계',
    ]);
  });
});
