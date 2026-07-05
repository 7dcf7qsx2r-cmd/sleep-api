export type UserStatus = 'active' | 'banned';
export type RegisterVia = 'phone' | 'wechat' | 'password';

export interface UserListItem {
  id: string;
  username: string;
  nickname: string | null;
  phone: string | null;
  phoneMasked: string | null;
  registerVia: RegisterVia;
  status: UserStatus;
  energyBalance: number;
  orderCount: number;
  totalSpentRmb: number;
  createdAt: string;
}

export interface UserListResult {
  items: UserListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EnergySummary {
  balance: number;
  totalEarned: number;
  totalSpent: number;
  streakDays: number;
}

export interface EnergyTransactionItem {
  id: string;
  type: string;
  amount: number;
  description: string;
  createdAt: string;
}

export interface OrderItem {
  id: string;
  productId: string;
  paymentMethod: string;
  energySpent: number | null;
  rmbAmount: number | null;
  status: string;
  createdAt: string;
}

export interface UserDetail {
  id: string;
  username: string;
  nickname: string | null;
  phone: string | null;
  phoneMasked: string | null;
  registerVia: RegisterVia;
  status: UserStatus;
  bannedAt: string | null;
  bannedReason: string | null;
  wechatBound: boolean;
  createdAt: string;
  energy: EnergySummary | null;
  recentEnergyTransactions: EnergyTransactionItem[];
  orderCount: number;
  totalSpentRmb: number;
  recentOrders: OrderItem[];
}
