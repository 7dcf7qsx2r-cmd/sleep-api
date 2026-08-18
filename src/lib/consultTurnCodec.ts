export type ConsultPhase =
  | 'triage'
  | 'clarify'
  | 'formulate'
  | 'plan'
  | 'safety'
  | 'closed';

export type ConsultIntent =
  | 'ask'
  | 'analyze'
  | 'answer_then_resume'
  | 'new_case'
  | 'boundary'
  | 'safety';

export interface ConsultTurnPayload {
  phase: ConsultPhase;
  progressStep: 1 | 2 | 3 | 4;
  intent?: ConsultIntent;
  topicLabel?: string;
  caseSummary?: string;
  empathy?: string;
  heard?: string;
  ack?: string;
  dataEvidence?: {
    metrics?: { label: string; value: string; trend?: 'up' | 'down' | 'flat' }[];
    note?: string;
  };
  collectedSlots?: { key: string; label: string; value: string }[];
  question?: {
    id: string;
    slotKey?: string;
    label?: string;
    prompt: string;
    type: string;
    options?: { id: string; label: string }[];
  };
  analysis?: {
    summary: string;
    mechanisms: { title: string; detail: string; confidence: 'likely' | 'possible' }[];
    limitations?: string;
  };
  plan?: {
    tonight: string[];
    thisWeek: string[];
    whenToSeekCare?: { department: string; when: string };
  };
  safety?: {
    title: string;
    bullets: string[];
    hotlineHint?: string;
  };
  showDisclaimer: boolean;
  followUpChips?: string[];
}

function progressStepForPhase(phase: ConsultPhase): 1 | 2 | 3 | 4 {
  switch (phase) {
    case 'triage': return 1;
    case 'clarify': return 2;
    case 'formulate': return 3;
    case 'plan':
    case 'closed': return 4;
    case 'safety': return 4;
    default: return 1;
  }
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

const INTENTS: ConsultIntent[] = [
  'ask',
  'analyze',
  'answer_then_resume',
  'new_case',
  'boundary',
  'safety',
];

export function parseConsultTurnPayload(text: string): ConsultTurnPayload | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const phase = raw.phase as ConsultPhase;
    if (!phase) return null;

    const progressStep = raw.progressStep;
    const step = (
      progressStep === 1 || progressStep === 2 || progressStep === 3 || progressStep === 4
    ) ? progressStep : progressStepForPhase(phase);

    const analysisRaw = raw.analysis as ConsultTurnPayload['analysis'] | undefined;
    const planRaw = raw.plan as ConsultTurnPayload['plan'] | undefined;
    const safetyRaw = raw.safety as ConsultTurnPayload['safety'] | undefined;
    const questionRaw = raw.question as ConsultTurnPayload['question'] | undefined;

    return {
      phase,
      progressStep: step,
      intent: INTENTS.includes(raw.intent as ConsultIntent) ? raw.intent as ConsultIntent : undefined,
      topicLabel: typeof raw.topicLabel === 'string' ? raw.topicLabel.slice(0, 16) : undefined,
      caseSummary: typeof raw.caseSummary === 'string' ? raw.caseSummary : undefined,
      empathy: typeof raw.empathy === 'string' ? raw.empathy : undefined,
      heard: typeof raw.heard === 'string' ? raw.heard : undefined,
      ack: typeof raw.ack === 'string' ? raw.ack : undefined,
      dataEvidence: raw.dataEvidence as ConsultTurnPayload['dataEvidence'],
      collectedSlots: Array.isArray(raw.collectedSlots)
        ? raw.collectedSlots as ConsultTurnPayload['collectedSlots']
        : undefined,
      question: questionRaw
        ? { ...questionRaw, options: questionRaw.options ?? [] }
        : undefined,
      analysis: analysisRaw
        ? { ...analysisRaw, mechanisms: analysisRaw.mechanisms ?? [] }
        : undefined,
      plan: planRaw
        ? {
            ...planRaw,
            tonight: planRaw.tonight ?? [],
            thisWeek: planRaw.thisWeek ?? [],
          }
        : undefined,
      safety: safetyRaw
        ? { ...safetyRaw, bullets: safetyRaw.bullets ?? [] }
        : undefined,
      showDisclaimer: raw.showDisclaimer === true,
      followUpChips: Array.isArray(raw.followUpChips)
        ? (raw.followUpChips as string[]).map(String)
        : undefined,
    };
  } catch {
    return null;
  }
}

export function validateConsultTurnPayload(
  payload: ConsultTurnPayload,
  _expectedPhase?: ConsultPhase,
): boolean {
  const phase = payload.phase;
  const intent = payload.intent;
  const hasQuestion = Boolean(payload.question?.prompt?.trim());
  const hasHeard = Boolean(payload.heard?.trim() || payload.ack?.trim() || payload.caseSummary?.trim());

  if (phase === 'safety' || intent === 'safety') {
    return Boolean(payload.safety?.title?.trim()) && (payload.safety?.bullets?.length ?? 0) >= 1;
  }
  if (intent === 'analyze' || phase === 'formulate') {
    return Boolean(payload.analysis?.summary?.trim())
      && (payload.analysis?.mechanisms?.length ?? 0) >= 1
      && Boolean(payload.plan?.tonight?.length);
  }
  if (intent === 'boundary' || phase === 'plan') {
    return Boolean(payload.plan?.tonight?.length) || Boolean(payload.ack?.trim());
  }
  if (intent === 'answer_then_resume' || intent === 'new_case') {
    return hasHeard && hasQuestion;
  }
  if (phase === 'triage' || phase === 'clarify' || intent === 'ask') {
    return hasHeard && (hasQuestion || Boolean(payload.analysis?.summary?.trim()));
  }
  return hasHeard;
}
