import {
  createContentItem,
  deleteContentItem,
  findContentById,
  findContentByKey,
  listContentItems,
  updateContentItem,
} from './operations.js';
import {
  mapSleepInterventionTrack,
  SLEEP_INTERVENTION_PLACEMENT,
  sleepInterventionCodeFromItem,
  sleepInterventionContentKey,
  type SleepInterventionTrack,
} from './sleepInterventionContract.js';

export {
  mapSleepInterventionTrack,
  SLEEP_INTERVENTION_PLACEMENT,
};
export type { SleepInterventionTrack };

export class SleepInterventionError extends Error {
  constructor(
    readonly code: 'not_found' | 'code_taken' | 'code_required',
    message: string,
  ) {
    super(message);
  }
}

function sortOrderForCode(code: string, fallback: number) {
  return /^\d{1,6}$/.test(code) ? Number(code) : fallback;
}

async function assertCodeAvailable(code: string, exceptId?: string) {
  const key = sleepInterventionContentKey(code);
  const existing = await findContentByKey(key);
  if (existing && existing.id !== exceptId && existing.placement === SLEEP_INTERVENTION_PLACEMENT) {
    throw new SleepInterventionError('code_taken', `编号 ${code} 已经有了`);
  }
  const rows = await listContentItems({
    placement: SLEEP_INTERVENTION_PLACEMENT,
    includeArchived: true,
  });
  const clash = rows.find((row) => row.id !== exceptId && sleepInterventionCodeFromItem(row) === code);
  if (clash) throw new SleepInterventionError('code_taken', `编号 ${code} 已经有了`);
}

export async function listSleepInterventionTracks(enabledOnly = false): Promise<SleepInterventionTrack[]> {
  const items = await listContentItems({
    placement: SLEEP_INTERVENTION_PLACEMENT,
    publishedOnly: enabledOnly,
  });
  return items
    .map((item) => mapSleepInterventionTrack(item))
    .filter((item): item is SleepInterventionTrack => item != null)
    .filter((item) => !enabledOnly || item.enabled);
}

async function writeTrack(id: string | null, input: {
  code: string;
  title: string;
  summary: string;
  enabled: boolean;
  audioUrl: string | null;
  coverUrl: string | null;
  sortOrder: number;
}) {
  const payload = {
    contentKey: sleepInterventionContentKey(input.code),
    placement: SLEEP_INTERVENTION_PLACEMENT,
    title: input.title,
    summary: input.summary,
    body: '',
    imageUrl: input.coverUrl,
    actionUrl: input.audioUrl,
    status: input.enabled ? 'published' as const : 'draft' as const,
    sortOrder: input.sortOrder,
    metadata: { kind: 'brainwave', code: input.code, enabled: input.enabled },
  };
  const saved = id
    ? (await updateContentItem(id, payload))?.after ?? null
    : await createContentItem(payload);
  return saved ? mapSleepInterventionTrack(saved) : null;
}

export async function createSleepInterventionTrack(input: {
  code: string;
  title: string;
  summary: string;
  enabled: boolean;
  audioUrl: string;
  coverUrl?: string | null;
}) {
  const code = input.code.trim();
  if (!code) throw new SleepInterventionError('code_required', '请填写编号');
  await assertCodeAvailable(code);
  const rows = await listSleepInterventionTracks(false);
  const track = await writeTrack(null, {
    code,
    title: input.title.trim() || '脑波干预',
    summary: input.summary.trim(),
    enabled: input.enabled,
    audioUrl: input.audioUrl,
    coverUrl: input.coverUrl ?? null,
    sortOrder: sortOrderForCode(code, rows.length + 1),
  });
  if (!track) throw new SleepInterventionError('not_found', '音频没有写入');
  return track;
}

export async function updateSleepInterventionTrack(id: string, input: {
  code?: string;
  title?: string;
  summary?: string;
  enabled?: boolean;
  audioUrl?: string;
  coverUrl?: string | null;
}) {
  const existing = await findContentById(id);
  const current = existing ? mapSleepInterventionTrack(existing) : null;
  if (!existing || !current) throw new SleepInterventionError('not_found', '找不到这条音频');
  const code = (input.code ?? current.code).trim();
  if (!code) throw new SleepInterventionError('code_required', '请填写编号');
  if (code !== current.code) await assertCodeAvailable(code, id);
  const track = await writeTrack(id, {
    code,
    title: (input.title ?? current.title).trim() || current.title,
    summary: input.summary ?? current.summary,
    enabled: input.enabled ?? current.enabled,
    audioUrl: input.audioUrl ?? current.audioUrl,
    coverUrl: input.coverUrl === undefined ? current.coverUrl : input.coverUrl,
    sortOrder: sortOrderForCode(code, current.sortOrder),
  });
  if (!track) throw new SleepInterventionError('not_found', '找不到这条音频');
  return track;
}

export async function deleteSleepInterventionTrack(id: string) {
  const existing = await findContentById(id);
  const current = existing ? mapSleepInterventionTrack(existing) : null;
  if (!current) throw new SleepInterventionError('not_found', '找不到这条音频');
  await deleteContentItem(id);
  return current;
}
