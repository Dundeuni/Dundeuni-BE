import { AnalysisModelResult } from '@prisma/client';
import { calculateOverallResult } from './image-analysis-policy';

const reasonCatalog = {
  AI_GENERATED_SUSPECTED: {
    type: 'GENERATION',
    title: 'AI 생성 의심 신호',
    description: 'AI 생성 분석에서 의심 기준 이상의 점수가 확인되었습니다.',
  },
  NO_CLEAR_GENERATION_SIGNAL: {
    type: 'GENERATION',
    title: '뚜렷한 AI 생성 신호 없음',
    description: 'AI 생성 분석에서 뚜렷한 의심 신호가 확인되지 않았습니다.',
  },
  MANIPULATION_SUSPECTED: {
    type: 'MANIPULATION',
    title: '이미지 변조 의심 신호',
    description: '이미지 변조 분석에서 의심 기준 이상의 점수가 확인되었습니다.',
  },
  NO_CLEAR_MANIPULATION_SIGNAL: {
    type: 'MANIPULATION',
    title: '뚜렷한 이미지 변조 신호 없음',
    description: '이미지 변조 분석에서 뚜렷한 의심 신호가 확인되지 않았습니다.',
  },
} as const;
type EvidenceCode = keyof typeof reasonCatalog;
export type SummaryReason = (typeof reasonCatalog)[EvidenceCode];

const source = {
  title: '이미지 출처 확인하기',
  description: '공식 홈페이지의 게시물이나 원본 자료와 비교해 보세요.',
};
const contact = {
  title: '공식 연락처로 확인하기',
  description:
    '이미지에 적힌 번호 대신 공식 홈페이지에서 연락처를 찾아 확인하세요.',
};
const privacy = {
  title: '송금과 개인정보 제공 멈추기',
  description:
    '요청한 사람과 실제 용도를 확인할 때까지 송금하거나 개인정보를 보내지 마세요.',
};
const ask = {
  title: '신뢰하는 사람과 함께 확인하기',
  description:
    '판단이 어렵다면 가족이나 믿을 수 있는 사람에게 함께 확인해 달라고 부탁하세요.',
};
const guides = [source, contact, privacy, ask];
const reassuranceChoices = [
  '서두르지 않아도 됩니다. 판단이 어렵다면 믿을 수 있는 사람과 함께 확인해 보세요.',
  '검사 결과를 참고하면서 출처와 요청 내용을 차근차근 확인해 보세요.',
];

export interface SummaryDetail {
  detailedReasons: SummaryReason[];
  actionGuides: { title: string; description: string }[];
  reassurance: string;
}

function verifiedEvidence(row: AnalysisModelResult): EvidenceCode | null {
  const { decision, kind, status, reasons } = row;
  if (
    status !== 'SUCCEEDED' ||
    row.displayScore === null ||
    !decision ||
    decision === 'INCONCLUSIVE' ||
    reasonCatalog[decision].type !== kind ||
    !Array.isArray(reasons)
  )
    return null;

  const names =
    kind === 'GENERATION'
      ? ['CuRe 생성 탐지']
      : ['FUSED 변조 탐지', 'TruFor 변조 탐지'];
  const suffix = decision.endsWith('SUSPECTED')
    ? ' 점수가 임시 의심 기준 이상입니다.'
    : ' 점수에서 뚜렷한 신호를 확인하지 못했습니다.';
  const known = names.map((name) => name + suffix);
  return reasons.some(
    (reason) =>
      reason &&
      typeof reason === 'object' &&
      !Array.isArray(reason) &&
      typeof reason.description === 'string' &&
      known.includes(reason.description),
  )
    ? decision
    : null;
}

export function summaryInput(rows: AnalysisModelResult[]) {
  const model = (kind: AnalysisModelResult['kind']) => {
    const row = rows.find((result) => result.kind === kind);
    return row
      ? {
          status: row.status,
          decision: row.decision,
          displayScore: row.displayScore,
          evidenceCode: verifiedEvidence(row),
        }
      : null;
  };
  const generation = model('GENERATION');
  const manipulation = model('MANIPULATION');
  return {
    generation,
    manipulation,
    overallResult: {
      decision: calculateOverallResult(generation, manipulation).decision,
    },
  };
}

export type SummaryInput = ReturnType<typeof summaryInput>;

const openings = {
  GENERATION_OR_MANIPULATION_SUSPECTED: [
    '이미지에서 생성이나 변조가 의심되는 신호가 확인되어 주의가 필요합니다.',
    '의심 신호가 확인되어 이미지의 출처를 다시 살펴볼 필요가 있습니다.',
  ],
  INCONCLUSIVE: [
    '이미지의 생성이나 변조 여부를 충분히 판단하기 어려웠습니다.',
    '이번 검사에서 확인할 수 있는 결과가 제한적입니다.',
  ],
  NO_CLEAR_SIGNAL: [
    '이번 검사에서 뚜렷한 생성이나 변조 의심 신호가 확인되지 않았습니다.',
    '이미지에서 생성이나 변조를 의심할 만한 뚜렷한 신호는 보이지 않았습니다.',
  ],
} as const;

export function summaryOptions(input: SummaryInput) {
  const explain = (label: string, model: SummaryInput['generation']) => {
    if (!model) return `${label} 검사는 요청되지 않았습니다.`;
    if (model.status === 'FAILED')
      return `${label} 검사를 완료하지 못했습니다.`;
    if (!model.decision || model.decision === 'INCONCLUSIVE')
      return `${label} 여부는 판단하기 어렵습니다.`;
    return model.decision.endsWith('SUSPECTED')
      ? `${label} 의심 신호가 확인되었습니다.`
      : `${label} 의심 신호는 뚜렷하지 않았습니다.`;
  };
  const models = [
    explain('AI 생성', input.generation),
    explain('이미지 변조', input.manipulation),
  ].join(' ');
  return {
    summaries: openings[input.overallResult.decision].map(
      (opening) => `${opening} ${models}`,
    ),
    detailedReasons: [
      input.generation?.evidenceCode,
      input.manipulation?.evidenceCode,
    ].flatMap((code) => (code ? [reasonCatalog[code]] : [])),
    actionGuides:
      input.overallResult.decision === 'GENERATION_OR_MANIPULATION_SUSPECTED'
        ? [privacy, contact, source, ask]
        : [source, ask, contact, privacy],
    reassurances: reassuranceChoices,
  };
}

export function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function parseSummaryDetail(
  value: unknown,
  allowedReasons: readonly SummaryReason[] = Object.values(reasonCatalog),
): SummaryDetail | null {
  if (
    !exactRecord(value, ['detailedReasons', 'actionGuides', 'reassurance']) ||
    !Array.isArray(value.detailedReasons) ||
    value.detailedReasons.length > 2 ||
    !Array.isArray(value.actionGuides) ||
    value.actionGuides.length !== 3 ||
    typeof value.reassurance !== 'string' ||
    !reassuranceChoices.includes(value.reassurance)
  )
    return null;

  const detailedReasons = value.detailedReasons.map((item) =>
    exactRecord(item, ['type', 'title', 'description'])
      ? allowedReasons.find(
          (reason) =>
            reason.type === item.type &&
            reason.title === item.title &&
            reason.description === item.description,
        )
      : undefined,
  );
  const actionGuides = value.actionGuides.map((item) =>
    exactRecord(item, ['title', 'description'])
      ? guides.find(
          (guide) =>
            guide.title === item.title &&
            guide.description === item.description,
        )
      : undefined,
  );
  if (
    !detailedReasons.every((item) => item !== undefined) ||
    new Set(detailedReasons.map((item) => item.type)).size !==
      detailedReasons.length ||
    !actionGuides.every((item) => item !== undefined) ||
    new Set(actionGuides).size !== actionGuides.length
  )
    return null;
  return { detailedReasons, actionGuides, reassurance: value.reassurance };
}

export function summaryResponseSchema(input: SummaryInput) {
  const options = summaryOptions(input);
  const text = (values: string[]) => ({ type: 'string', enum: values });
  const object = (properties: Record<string, unknown>) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  const item = (
    choices: { title: string; description: string }[],
    extra = {},
  ) =>
    object({
      title: text(choices.map(({ title }) => title)),
      description: text(choices.map(({ description }) => description)),
      ...extra,
    });
  const decision = (value: string | null) =>
    value === null ? { type: 'null' } : text([value]);
  const count = options.detailedReasons.length;
  return object({
    summary: text(options.summaries),
    detailedReasons: {
      type: 'array',
      minItems: count,
      maxItems: count,
      ...(count
        ? {
            items: item(options.detailedReasons, {
              type: text(options.detailedReasons.map(({ type }) => type)),
            }),
          }
        : { items: { type: 'object' } }),
    },
    actionGuides: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: item(options.actionGuides),
    },
    reassurance: text(options.reassurances),
    generationDecision: decision(input.generation?.decision ?? null),
    manipulationDecision: decision(input.manipulation?.decision ?? null),
    overallDecision: text([input.overallResult.decision]),
  });
}
