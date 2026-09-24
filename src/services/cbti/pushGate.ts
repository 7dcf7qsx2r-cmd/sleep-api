import { sleepNightDate } from '../../utils/civilDate.js';
import { PUSH_CATEGORY_RULES, setPushGate, type PushGate } from '../push.js';
import { nightWindowInstants } from './nightMonitor.js';
import { getFlags, loadLivePlan } from './plans.js';

/** 服务端推送在计划模式下每天最多条数（不含离床、安全类）；本地通知另算，合计上限由 App 调度器控制。 */
export const SERVER_PLAN_PUSH_DAILY_CAP = 3;
export const SERVER_GENERAL_PUSH_DAILY_CAP = 1;

/** CB-PSH-06：计划模式下，夜间时段只放行离床和安全类，其它延后到起床锚；超出每日上限的丢弃。 */
export const cbtiPushGate: PushGate = async ({ userId, category, now, sentTodayNonExempt }) => {
  if (PUSH_CATEGORY_RULES[category].exempt) return { action: 'send' };
  const plan = await loadLivePlan(userId);
  if (!plan || plan.mode_disabled) return { action: 'send' };
  const flags = await getFlags();
  if (flags.modeKillSwitch) return { action: 'send' };

  if (plan.status === 'baseline' || plan.status === 'active') {
    const win = nightWindowInstants(plan, sleepNightDate(now));
    if (now.getTime() >= win.startMs && now.getTime() < win.endMs) {
      return { action: 'defer', until: new Date(win.endMs) };
    }
  }
  const cap = category === 'general' ? SERVER_GENERAL_PUSH_DAILY_CAP : SERVER_PLAN_PUSH_DAILY_CAP;
  if (sentTodayNonExempt >= cap) return { action: 'drop', reason: 'daily_cap' };
  return { action: 'send' };
};

export function registerCbtiPushGate(): void {
  setPushGate(cbtiPushGate);
}
