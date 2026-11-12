/** 与 App 端 GARDEN_DAILY_HARVEST_CAP、盛开单株 7 点对齐。 */
export const GARDEN_HARVEST_DAILY_CAP = 28;
export const GARDEN_HARVEST_CLAIM_MAX = 7;

export function parseGardenHarvestDay(sourceId: string): string | null {
  const match = /^garden:(\d{4}-\d{2}-\d{2}):/.exec(sourceId);
  return match?.[1] ?? null;
}

/** 单次最多一株盛开，且当日累计不超过园收上限。 */
export function clampGardenHarvestAmount(amount: number, alreadyEarned: number): number {
  const room = GARDEN_HARVEST_DAILY_CAP - Math.max(0, alreadyEarned);
  if (room <= 0) return 0;
  const requested = Math.floor(amount);
  if (requested <= 0) return 0;
  return Math.min(requested, GARDEN_HARVEST_CLAIM_MAX, room);
}
