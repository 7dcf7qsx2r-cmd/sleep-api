export interface EnergyTaskDef {
  id: string;
  name: string;
  reward: number;
  dailyLimit: number;
}

export const ENERGY_TASKS: EnergyTaskDef[] = [
  { id: 'breathing', name: '478呼吸练习', reward: 5, dailyLimit: 2 },
  { id: 'meditation', name: '冥想引导', reward: 10, dailyLimit: 1 },
  { id: 'dream_record', name: '记录梦境', reward: 8, dailyLimit: 2 },
  { id: 'social_like', name: '社区互动', reward: 5, dailyLimit: 1 },
  { id: 'share_report', name: '分享报告', reward: 15, dailyLimit: 1 },
  { id: 'early_sleep', name: '早睡打卡', reward: 20, dailyLimit: 1 },
  { id: 'dream_standin_read', name: '拆阅梦境来信', reward: 6, dailyLimit: 1 },
  { id: 'dream_standin_diary', name: '来信记入梦日记', reward: 8, dailyLimit: 2 },
  { id: 'dream_standin_merge', name: '双线梦境合并', reward: 10, dailyLimit: 1 },
  // P3 social tasks
  { id: 'send_bottle', name: '投递梦境瓶', reward: 10, dailyLimit: 3 },
  { id: 'pick_bottle', name: '收取梦境瓶', reward: 8, dailyLimit: 5 },
  { id: 'reply_bottle', name: '回复梦境瓶', reward: 12, dailyLimit: 5 },
  { id: 'post_feed', name: '发布动态', reward: 5, dailyLimit: 3 },
  { id: 'like_feed', name: '点赞动态', reward: 2, dailyLimit: 10 },
];

export function getTaskDef(taskId: string): EnergyTaskDef | undefined {
  return ENERGY_TASKS.find((t) => t.id === taskId);
}
