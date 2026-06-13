export interface ShopProduct {
  id: string;
  icon: string;
  name: string;
  description: string;
  energyPrice: number;
  originalEnergyPrice: number;
  rmbPrice: number;
  originalRmbPrice: number;
}

export const SHOP_PRODUCTS: ShopProduct[] = [
  {
    id: 'p1', icon: '🛏️', name: 'AI智能睡眠监测带',
    description: '精确到分钟级追踪每个睡眠阶段，AI每周给你优化建议',
    energyPrice: 39900, originalEnergyPrice: 59900,
    rmbPrice: 39.9, originalRmbPrice: 69.9,
  },
  {
    id: 'p2', icon: '🕶️', name: '石墨烯热敷眼罩',
    description: '远红外线温和激活副交感神经，加快入睡速度',
    energyPrice: 18900, originalEnergyPrice: 26900,
    rmbPrice: 19.9, originalRmbPrice: 29.9,
  },
  {
    id: 'p3', icon: '🍵', name: '酸枣仁安神茶',
    description: '酸枣仁+百合+茯苓经典配伍，2-3周夜间觉醒明显减少',
    energyPrice: 12800, originalEnergyPrice: 19800,
    rmbPrice: 12.9, originalRmbPrice: 19.9,
  },
  {
    id: 'p4', icon: '🎧', name: '白噪音会员月卡',
    description: '解锁全部白噪音场景，无广告纯净体验',
    energyPrice: 15000, originalEnergyPrice: 20000,
    rmbPrice: 15, originalRmbPrice: 22,
  },
  {
    id: 'p5', icon: '🎨', name: '小眠限定皮肤',
    description: '专属星空主题皮肤，让睡眠界面更梦幻',
    energyPrice: 29900, originalEnergyPrice: 39900,
    rmbPrice: 29.9, originalRmbPrice: 39.9,
  },
];

export function getShopProduct(id: string): ShopProduct | undefined {
  return SHOP_PRODUCTS.find((p) => p.id === id);
}
