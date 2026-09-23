/** App 与上传页共用的内容位。改名时两边要一起改。 */
export const SLEEP_INTERVENTION_PLACEMENT = 'sleep_intervention';

export interface SleepInterventionTrack {
  id: string;
  code: string;
  title: string;
  summary: string;
  coverUrl: string | null;
  audioUrl: string | null;
  enabled: boolean;
  playable: boolean;
  sortOrder: number;
}

export function sleepInterventionContentKey(code: string): string {
  return `sleep-intervention:${code}`;
}

export function sleepInterventionCodeFromItem(item: {
  contentKey: string;
  metadata?: unknown;
}): string {
  const metadata = item.metadata && typeof item.metadata === 'object'
    ? item.metadata as Record<string, unknown>
    : {};
  if (typeof metadata.code === 'string' && metadata.code.trim()) return metadata.code.trim();
  const prefixed = /^sleep-intervention:(.+)$/.exec(item.contentKey);
  if (prefixed?.[1]) return prefixed[1];
  if (item.contentKey === 'sleep-intervention-primary') return '1';
  return item.contentKey;
}

export function mapSleepInterventionTrack(item: {
  id: string;
  contentKey: string;
  placement: string;
  title: string;
  summary: string;
  imageUrl: string | null;
  actionUrl: string | null;
  status: string;
  sortOrder: number;
  metadata?: unknown;
}): SleepInterventionTrack | null {
  if (item.placement !== SLEEP_INTERVENTION_PLACEMENT) return null;
  const metadata = item.metadata && typeof item.metadata === 'object'
    ? item.metadata as Record<string, unknown>
    : {};
  const audioUrl = item.actionUrl?.trim() || null;
  const enabled = item.status === 'published' && metadata.enabled !== false;
  return {
    id: item.id,
    code: sleepInterventionCodeFromItem(item),
    title: item.title,
    summary: item.summary,
    coverUrl: item.imageUrl,
    audioUrl,
    enabled,
    playable: enabled && Boolean(audioUrl),
    sortOrder: item.sortOrder,
  };
}
