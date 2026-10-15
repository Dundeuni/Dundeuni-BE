import { Injectable } from '@nestjs/common';

@Injectable()
export class AnalysisUsageService {
  async reserveAiUsage(_userId: string, _analysisId: string): Promise<void> {
    // TODO: Usage 서비스 연결. analysisId 단위 원자적 예약/중복 방지 및 USAGE429 처리.
    // 차감/실패 복구 정책 미확정. 현재 이용량을 실제로 차감하지 않는다.
  }
  async releaseAiUsage(_userId: string, _analysisId: string): Promise<void> {
    // TODO: 확정된 실패 복구 정책에 맞춰 Usage 서비스 연결.
  }
}
