import { ImageHistorySummaryService } from '../src/domains/analysis/image-history-summary.service';

describe('stored image/screenshot summary projection', () => {
  const service = new ImageHistorySummaryService();
  const stored = {
    summary:
      '  DB에 저장된 Gemini 요약본입니다. 생성·변조 결과를 설명합니다.  ',
    summaryStatus: 'COMPLETED' as const,
    summaryModel: 'gemini-stored-test',
    summarizedAt: new Date('2026-11-21T10:00:00.000Z'),
  };
  it.each(['IMAGE', 'SCREEN'])(
    'uses the same stored-field projection for %s without introducing a storage enum',
    (type) => {
      expect(service.supports(type)).toBe(true);
      expect(service.project(stored)).toEqual({
        ...stored,
        summarizedAt: stored.summarizedAt.toISOString(),
      });
    },
  );
  it.each(['TEXT', 'URL', 'PHONE'])(
    'does not reinterpret %s results as image summaries',
    (type) => {
      expect(service.supports(type)).toBe(false);
    },
  );
  it.each(['PENDING', 'FAILED', null] as const)(
    'preserves %s and hides stale summary metadata',
    (status) => {
      expect(service.project({ ...stored, summaryStatus: status })).toEqual({
        summary: null,
        summaryStatus: status,
        summaryModel: null,
        summarizedAt: null,
      });
    },
  );
  it.each([null, '', '   '])(
    'does not generate or invent a missing COMPLETED summary: %s',
    (summary) => {
      expect(service.project({ ...stored, summary })).toMatchObject({
        summary: null,
        summaryStatus: 'COMPLETED',
      });
    },
  );
});
