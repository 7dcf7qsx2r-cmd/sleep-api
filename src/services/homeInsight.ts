import type { SleepNight } from '../types/sleepNight.js';
import { callDeepSeek } from '../lib/deepseek.js';
import { hasMorningCheckInToday, getLastNight } from './sleepNights.js';

export interface HomeInsightPayload {
  line: string;
  ctaLabel: string;
  action: string;
  isAi: boolean;
  isFallback: boolean;
}

export interface HomeInsightInput {
  nickname: string;
  dreamCount: number;
  sleepType?: string;
  questionnaireDone?: boolean;
  nights: SleepNight[];
}

function timeSlot(hour: number): string {
  if (hour < 6) return '深夜';
  if (hour < 12) return '早上';
  if (hour < 18) return '下午';
  return '傍晚';
}

function timeSlotLabel(hour: number): string {
  if (hour >= 5 && hour < 12) return '早晨';
  if (hour >= 12 && hour < 17) return '午后';
  if (hour >= 17 && hour < 22) return '傍晚';
  return '深夜';
}

function formatMinutes(minutes: number): string {
  if (minutes <= 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h <= 0) return `${m}分`;
  return m > 0 ? `${h}小时${m}分` : `${h}小时`;
}

function countDataNights(nights: SleepNight[]): number {
  return nights.filter((n) => n.durationMinutes > 0 || n.checkInAt).length;
}

function scoreTrendSummary(nights: SleepNight[]): string | null {
  const scores = nights
    .filter((n) => n.score > 0)
    .slice(-7)
    .map((n) => n.score);
  if (scores.length < 3) return null;
  const recent = scores.slice(-3);
  if (recent[0]! > recent[1]! && recent[1]! > recent[2]!) {
    return `近 3 晚评分 ${recent.join('→')}，连续走低`;
  }
  if (recent[0]! < recent[1]! && recent[1]! < recent[2]!) {
    return `近 3 晚评分 ${recent.join('→')}，连续走高`;
  }
  return null;
}

export function buildHomeInsightFacts(input: HomeInsightInput): string {
  const hour = new Date().getHours();
  const { nickname, sleepType, questionnaireDone, dreamCount, nights } = input;
  const last = getLastNight(nights);
  const chapter = countDataNights(nights);
  const checkedIn = hasMorningCheckInToday(nights);
  const scoreTrend = scoreTrendSummary(nights);

  const lines = [
    `【时段】${timeSlotLabel(hour)}（${hour}:00）`,
    `【称呼】${nickname}`,
    questionnaireDone
      ? `【睡眠类型】${sleepType || '已填写问卷'}`
      : '【问卷】未完成',
    `【连载进度】${chapter === 0 ? '序章，尚无归档晚' : `已归档 ${chapter} 晚`}`,
    `【今日晨间打卡】${checkedIn ? '已完成' : '未完成'}`,
    `【梦境日记】${dreamCount} 条`,
  ];

  if (last && last.durationMinutes > 0) {
    lines.push(
      '',
      `【昨夜】评分 ${last.score}，总时长 ${formatMinutes(last.durationMinutes)}，`
        + `深睡 ${formatMinutes(last.deepMinutes)}，REM ${formatMinutes(last.remMinutes)}`,
    );
  } else {
    lines.push('', '【昨夜】无睡眠归档数据');
  }

  if (scoreTrend) lines.push(`【评分走势】${scoreTrend}`);

  const nsOpen = hour >= 20 || hour < 6;
  if (questionnaireDone) {
    lines.push(`【小眠夜校】${nsOpen ? '已开门（20:00 后）' : '未开门'}`);
  }

  return lines.join('\n');
}

export function buildHomeInsightFallback(input: HomeInsightInput): HomeInsightPayload {
  const hour = new Date().getHours();
  const slot = timeSlot(hour);
  const { nickname, dreamCount, questionnaireDone, nights } = input;
  const checkedIn = hasMorningCheckInToday(nights);
  const last = getLastNight(nights);
  const chapter = countDataNights(nights);
  const scoreTrend = scoreTrendSummary(nights);

  if (!questionnaireDone) {
    return {
      line: `${nickname}，3 分钟问卷能让小眠第一句就喊对你的名字。`,
      ctaLabel: '做问卷',
      action: 'questionnaire',
      isAi: false,
      isFallback: true,
    };
  }

  if (chapter === 0 && !checkedIn && hour >= 5 && hour < 22) {
    return {
      line: `${slot}好～睡眠连载还没开篇，30 秒告诉小眠昨晚怎样，第一格就亮。`,
      ctaLabel: '30秒打卡',
      action: 'morning_checkin',
      isAi: false,
      isFallback: true,
    };
  }

  if (!checkedIn && hour >= 5 && hour < 22) {
    return {
      line: `${slot}好，今日还没打卡——补一格，报告里的故事才接得上。`,
      ctaLabel: '去打卡',
      action: 'morning_checkin',
      isAi: false,
      isFallback: true,
    };
  }

  if (scoreTrend?.includes('走低')) {
    return {
      line: `${scoreTrend}，小眠在报告里标了拐点，一起看看哪一维在拖后腿。`,
      ctaLabel: '看报告',
      action: 'report',
      isAi: false,
      isFallback: true,
    };
  }

  if (last && last.durationMinutes > 0) {
    const total = last.durationMinutes;
    const deepRatio = total > 0 ? last.deepMinutes / total : 0;
    if (deepRatio < 0.18 && total >= 300) {
      return {
        line: `昨夜深睡偏少（${Math.round(deepRatio * 100)}%），${slot}试试 5 分钟呼吸再睡？`,
        ctaLabel: '呼吸放松',
        action: 'meditation',
        isAi: false,
        isFallback: true,
      };
    }
    if (total < 360) {
      const dur = formatMinutes(total);
      return {
        line: `昨夜只睡了 ${dur}，今晚比昨天早半小时，连载会好看很多。`,
        ctaLabel: '看报告',
        action: 'report',
        isAi: false,
        isFallback: true,
      };
    }
    if (last.score >= 82) {
      return {
        line: `昨夜 ${last.score} 分，状态不错——${hour >= 19 || hour < 6 ? '按这个节奏准备入睡吧' : '保持这个节奏'}。`,
        ctaLabel: '看报告',
        action: 'report',
        isAi: false,
        isFallback: true,
      };
    }
  }

  if ((hour >= 20 && hour < 24) || hour < 1) {
    return {
      line: `${slot}了，小眠夜校已开门 — 3 分钟就到课，完课攒能量。`,
      ctaLabel: '进夜校',
      action: 'night_school',
      isAi: false,
      isFallback: true,
    };
  }

  if (dreamCount === 0 && hour >= 19) {
    return {
      line: `${slot}了，写下一个梦或和小眠聊聊，今晚的连载会更有趣。`,
      ctaLabel: '记梦',
      action: 'dream_record',
      isAi: false,
      isFallback: true,
    };
  }

  if (hour >= 19 || hour < 6) {
    return {
      line: `${slot}了，要不要先听一段白噪音？`,
      ctaLabel: '助眠音律',
      action: 'sound_player',
      isAi: false,
      isFallback: true,
    };
  }

  if (chapter > 0 && chapter < 7) {
    return {
      line: `睡眠故事写到第 ${chapter} 章了，再记 ${7 - chapter} 晚就能解锁周肖像。`,
      ctaLabel: '看连载',
      action: 'report',
      isAi: false,
      isFallback: true,
    };
  }

  return {
    line: `${nickname}，小眠在这儿——想聊睡眠、做梦或今晚怎么睡，都可以。`,
    ctaLabel: '和小眠聊',
    action: 'companion',
    isAi: true,
    isFallback: true,
  };
}

const HOME_INSIGHT_SYSTEM = `你是小眠，用户的睡眠陪伴者。请写首页「今日一句」——像枕边便签，不是医学报告。

输出 JSON：
{
  "line": "40字以内，口语，一句完整话，必须具体（数字/趋势/章节/困扰之一）",
  "ctaLabel": "4-8字按钮文案",
  "action": "morning_checkin|report|companion|sound_player|sleep_monitor|meditation|questionnaire|night_school|dream_record"
}

原则：
- 早晨(5-12)优先打卡/回顾；傍晚(17-22)优先就寝准备；深夜优先放松入睡
- 无数据/序章：邀请 30 秒打卡开篇，禁止空泛「波动较大」
- 有数据：引用评分、时长、趋势中的至少一项
- 温柔、像朋友说话，不做诊断、不恐吓
- 只输出 JSON`;

function parseHomeInsightJson(text: string): Pick<HomeInsightPayload, 'line' | 'ctaLabel' | 'action'> | null {
  try {
    const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const line = String(parsed.line ?? '').trim().slice(0, 56);
    const ctaLabel = String(parsed.ctaLabel ?? '').trim().slice(0, 10) || '去看看';
    const action = String(parsed.action ?? 'companion').trim();
    if (!line) return null;
    return { line, ctaLabel, action };
  } catch {
    return null;
  }
}

export async function generateHomeDailyInsight(
  input: HomeInsightInput,
): Promise<HomeInsightPayload> {
  const fallback = buildHomeInsightFallback(input);
  const facts = buildHomeInsightFacts(input);
  const prompt = `根据以下用户情境，写今日首页一句（JSON）：\n\n${facts}`;

  const aiResult = await callDeepSeek({
    messages: [
      { role: 'system', content: HOME_INSIGHT_SYSTEM },
      { role: 'user', content: prompt },
    ],
    temperature: 0.75,
    maxTokens: 180,
    timeoutMs: 15_000,
    fallback: JSON.stringify({
      line: fallback.line,
      ctaLabel: fallback.ctaLabel,
      action: fallback.action,
    }),
  });

  const parsed = parseHomeInsightJson(aiResult.text);
  if (parsed && !aiResult.isFallback) {
    return { ...parsed, isAi: true, isFallback: false };
  }
  if (parsed) {
    return { ...parsed, isAi: false, isFallback: true };
  }
  return fallback;
}
