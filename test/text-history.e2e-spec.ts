import { AnalysisHistoryService } from '../src/domains/analysis/analysis-history.service';
import { AnalysisHistoryRepository } from '../src/domains/analysis/analysis-history.repository';

describe('TEXT stored history projection', () => {
  const repository = {
    list: jest.fn(),
    findOwnedActive: jest.fn(),
  };
  const service = new AnalysisHistoryService(
    repository as unknown as AnalysisHistoryRepository,
  );
  const id = 'd734f69e-ce2e-4914-8a2e-230713d37c96';
  const row = {
    id,
    type: 'TEXT',
    status: 'COMPLETED',
    aiGenerationScore: null,
    aiRiskLevel: null,
    reasons: null,
    textPreview: '가'.repeat(200),
    textResult: {
      decision: 'phishing',
      riskScore: 0.75,
      scoreMeaning: 'UNCALIBRATED_CLASSIFIER_SCORE',
      modelVersion: 'text-v1',
      policyVersion: 'risk-v1',
      quality: { needsReview: true },
      evidence: ['private raw evidence'],
      limitations: ['private raw limitations'],
      text: 'private input',
    },
    createdAt: new Date('2026-11-22T10:00:00Z'),
    completedAt: new Date('2026-11-22T10:00:01Z'),
  };
  beforeEach(() => {
    repository.list.mockReset().mockResolvedValue([[row], 1]);
    repository.findOwnedActive.mockReset().mockResolvedValue(row);
  });
  it('lists stored 200-character preview without calling an AI provider', async () => {
    const response = await service.list('owner', { page: 1, limit: 20 });
    expect(response.result.items[0].targetSummary).toHaveLength(200);
    expect(repository.list).toHaveBeenCalledWith('owner', 0, 20, expect.any(Date));
  });
  it('only exposes allowlisted stored risk fields', async () => {
    const response = await service.findOne('owner', id);
    expect(response.result.detail).toMatchObject({
      textPreview: '가'.repeat(200),
      decision: 'phishing',
      riskScore: 0.75,
      needsReview: true,
    });
    expect(JSON.stringify(response)).not.toMatch(/private raw|private input|evidence|limitations/);
    expect(repository.findOwnedActive).toHaveBeenCalledWith(id, 'owner', expect.any(Date));
  });
  it('returns 404 for missing or unauthorized records', async () => {
    repository.findOwnedActive.mockResolvedValueOnce(null);
    await expect(service.findOne('other', id)).rejects.toMatchObject({ status: 404 });
  });
});
