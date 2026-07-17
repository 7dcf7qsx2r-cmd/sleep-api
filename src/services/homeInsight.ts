import type { SleepNight } from '../types/sleepNight.js';
import { hasMorningCheckInToday, getLastNight } from './sleepNights.js';

export interface HomeInsightPayload {
  line: string;
  ctaLabel: string;
  action: string;
  isAi: boolean;
  isFallback: boolean;
}

function timeSlot(hour: number): string {
  if (hour < 6) return '深夜';
  if (hour < 12) return '早上';
  if (hour < 18) return '下午';
  return '傍晚';
}

export function buildHomeInsightFallback(
  nickname: string,
  nights: SleepNight[],
  dreamCount: number,
): HomeInsightPayload {
  const hour = new Date().getHours();
  const slot = timeSlot(hour);
  const checkedIn = hasMorningCheckInToday(nights);
  const last = getLastNight(nights);
  const dataNights = nights.filter((n) => n.durationMinutes > 0 || n.checkInAt).length;

  if (dataNights === 0 && !checkedIn && hour >= 5 && hour < 22) {
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

  if (last && last.durationMinutes > 0 && last.durationMinutes < 360) {
    const h = Math.floor(last.durationMinutes / 60);
    const m = last.durationMinutes % 60;
    const dur = m > 0 ? `${h}小时${m}分` : `${h}小时`;
    return {
      line: `昨夜只睡了 ${dur}，今晚比昨天早半小时，连载会好看很多。`,
      ctaLabel: '看报告',
      action: 'report',
      isAi: false,
      isFallback: true,
    };
  }

  if (last && last.score >= 82) {
    return {
      line: `昨夜 ${last.score} 分，状态不错——${hour >= 19 || hour < 6 ? '按这个节奏准备入睡吧' : '保持这个节奏'}。`,
      ctaLabel: '看报告',
      action: 'report',
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

  return {
    line: `${nickname}，小眠在这儿——想聊睡眠、做梦或今晚怎么睡，都可以。`,
    ctaLabel: '和小眠聊',
    action: 'companion',
    isAi: true,
    isFallback: true,
  };
}
