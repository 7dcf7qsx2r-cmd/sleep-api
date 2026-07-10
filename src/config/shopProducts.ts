export interface ShopProduct {
  id: string;
  category?: 'recommend' | 'sleep' | 'wellness' | 'beauty' | 'energy';
  icon: string;
  name: string;
  summary: string;
  description: string;
  aiReason: string;
  shopName: string;
  imageSlides: string[];
  details: string[];
  energyPrice: number;
  originalEnergyPrice: number;
  rmbPrice: number;
  originalRmbPrice: number;
  stock?: number | null;
  status?: 'draft' | 'published' | 'archived';
  sortOrder?: number;
}

export const SHOP_PRODUCTS: ShopProduct[] = [
  {
    id: 'p1', icon: '🛏️', name: 'AI智能睡眠监测带',
    summary: '分钟级睡眠分期，周报自动优化作息',
    description: '精确到分钟级追踪每个睡眠阶段，AI每周给你优化建议',
    aiReason: '你的深睡占比偏低，这款监测带能帮你看见每晚结构变化，适合想「量化改善」的你。',
    shopName: '小眠睡眠实验室',
    imageSlides: ['moonlight', 'deepsleep', 'aurora'],
    details: ['医用级柔性传感器', 'AI 周报 + 作息建议', '蓝牙同步，续航 7 天', '支持家庭共享查看'],
    energyPrice: 39900, originalEnergyPrice: 59900,
    rmbPrice: 39.9, originalRmbPrice: 69.9,
    sortOrder: 1,
  },
  {
    id: 'p2', icon: '🕶️', name: '石墨烯热敷眼罩',
    summary: '远红外热敷，放松眼周助入睡',
    description: '远红外线温和激活副交感神经，加快入睡速度',
    aiReason: '你常在睡前使用屏幕，眼周紧张会影响入睡；热敷眼罩能帮你更快切换到放松状态。',
    shopName: '眠愈好物馆',
    imageSlides: ['aurora', 'moonlight'],
    details: ['石墨烯均匀发热', '三档温控定时', '可拆洗亲肤面料', '折叠便携'],
    energyPrice: 18900, originalEnergyPrice: 26900,
    rmbPrice: 19.9, originalRmbPrice: 29.9,
    sortOrder: 2,
  },
  {
    id: 'p3', icon: '🍵', name: '酸枣仁安神茶',
    summary: '经典安神配伍，减少夜醒',
    description: '酸枣仁+百合+茯苓经典配伍，2-3周夜间觉醒明显减少',
    aiReason: '你的入睡潜伏期略长，食疗调理更温和；这款茶适合作为睡前 30 分钟的仪式。',
    shopName: '食疗养生社',
    imageSlides: ['deepsleep', 'moonlight'],
    details: ['独立小包装', '无咖啡因', '建议连续饮用 2–3 周', '孕妇请咨询医师'],
    energyPrice: 12800, originalEnergyPrice: 19800,
    rmbPrice: 12.9, originalRmbPrice: 19.9,
    sortOrder: 3,
  },
  {
    id: 'p4', icon: '🎧', name: '白噪音会员月卡',
    summary: '全场景白噪音，无广告纯净听',
    description: '解锁全部白噪音场景，无广告纯净体验',
    aiReason: '你使用过助眠音律，升级会员可解锁雨声、海浪等全部场景，睡前更沉浸。',
    shopName: '小眠官方',
    imageSlides: ['aurora', 'deepsleep'],
    details: ['30 天会员', '全场景解锁', '支持后台播放', '自动续费可关闭'],
    energyPrice: 15000, originalEnergyPrice: 20000,
    rmbPrice: 15, originalRmbPrice: 22,
    sortOrder: 4,
  },
  {
    id: 'p5', icon: '🎨', name: '小眠限定皮肤',
    summary: '星空主题界面，专属月光氛围',
    description: '专属星空主题皮肤，让睡眠界面更梦幻',
    aiReason: '你喜欢沉浸式界面，限定皮肤让每晚打开 App 都像进入自己的梦境星空。',
    shopName: '能量值专区',
    imageSlides: ['moonlight', 'aurora', 'deepsleep'],
    details: ['永久拥有', '全局主题替换', '含专属图标包', '能量值专享兑换'],
    energyPrice: 29900, originalEnergyPrice: 39900,
    rmbPrice: 29.9, originalRmbPrice: 39.9,
    sortOrder: 5,
  },
];

export function getShopProduct(id: string): ShopProduct | undefined {
  return SHOP_PRODUCTS.find((p) => p.id === id);
}
