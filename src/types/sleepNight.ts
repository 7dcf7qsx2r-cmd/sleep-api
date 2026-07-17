/** 与 sleep-app-rn SleepNight 对齐（sync domain sleep_nights） */
export type SubjectiveMood = 1 | 2 | 3 | 4;
export type BedtimeBucket = 'before_23' | '23_01' | 'after_01';

export interface SleepNight {
  id: string;
  nightDate: string;
  timezone?: string;
  score: number;
  durationMinutes: number;
  deepMinutes: number;
  lightMinutes: number;
  remMinutes: number;
  awakeMinutes: number;
  latencyMinutes?: number;
  awakenings?: number;
  avgHeartRate?: number;
  avgBreathRate?: number;
  primarySource?: string;
  confidence?: 'low' | 'medium' | 'high';
  subjectiveMood?: SubjectiveMood;
  bedtimeBucket?: BedtimeBucket;
  morningTags?: string[];
  checkInAt?: string;
  synthesizedAt?: string;
  version?: number;
}

export function nightDateToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseSleepNights(data: unknown): SleepNight[] {
  if (!Array.isArray(data)) return [];
  return data.filter((n) => n && typeof n === 'object' && typeof (n as SleepNight).nightDate === 'string') as SleepNight[];
}
