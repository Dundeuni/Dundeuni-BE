import { Injectable } from '@nestjs/common';
import { Analysis } from '@prisma/client';
import { ImageHistorySummaryDto } from './dto/image-history-summary.dto';

type StoredImageSummary = Pick<
  Analysis,
  'summary' | 'summaryStatus' | 'summaryModel' | 'summarizedAt'
>;

/** Read-only shared image/screenshot projection. No Gemini client, queue or configuration dependency. */
@Injectable()
export class ImageHistorySummaryService {
  supports(type: string): boolean {
    // SCREEN is not an enum/storage path in current dev. If a future branch introduces
    // it, its persisted fields use this same projection; no new enum is introduced here.
    return type === 'IMAGE' || type === 'SCREEN';
  }

  project(row: StoredImageSummary): ImageHistorySummaryDto {
    const completed = row.summaryStatus === 'COMPLETED';
    const hasSummary = completed && Boolean(row.summary?.trim());
    return {
      summary: hasSummary ? row.summary : null,
      summaryStatus: row.summaryStatus,
      summaryModel: hasSummary ? row.summaryModel : null,
      summarizedAt: hasSummary
        ? (row.summarizedAt?.toISOString() ?? null)
        : null,
    };
  }
}
