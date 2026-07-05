import { closeDb, query } from './client.js';

const MIGRATION_STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`,
  `CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
)`,
  `CREATE TABLE IF NOT EXISTS guest_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  merged_to_user_id UUID REFERENCES users(id)
)`,
  `CREATE TABLE IF NOT EXISTS user_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT,
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS ai_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('guest', 'user')),
  subject_id UUID NOT NULL,
  usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
  chat_count INT NOT NULL DEFAULT 0,
  interpret_count INT NOT NULL DEFAULT 0,
  UNIQUE (subject_type, subject_id, usage_date)
)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_usage_subject
  ON ai_usage_daily (subject_type, subject_id, usage_date)`,
  `CREATE INDEX IF NOT EXISTS idx_guest_device
  ON guest_sessions (device_id)`,
  `CREATE TABLE IF NOT EXISTS data_blobs (
  owner_type TEXT NOT NULL CHECK (owner_type IN ('guest', 'user')),
  owner_id UUID NOT NULL,
  domain TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_type, owner_id, domain)
)`,
  `CREATE INDEX IF NOT EXISTS idx_data_blobs_updated
  ON data_blobs (owner_type, owner_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS sync_changelog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type TEXT NOT NULL,
  owner_id UUID NOT NULL,
  domain TEXT NOT NULL,
  version INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE INDEX IF NOT EXISTS idx_sync_changelog_owner_time
  ON sync_changelog (owner_type, owner_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS energy_accounts (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance INT NOT NULL DEFAULT 500,
  total_earned INT NOT NULL DEFAULT 500,
  total_spent INT NOT NULL DEFAULT 0,
  streak_days INT NOT NULL DEFAULT 0,
  max_streak_days INT NOT NULL DEFAULT 0,
  daily_earned INT NOT NULL DEFAULT 0,
  daily_cap INT NOT NULL DEFAULT 200,
  last_check_in DATE,
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS energy_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount INT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_id TEXT UNIQUE,
  related_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS energy_task_daily (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
  completed_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, task_id, usage_date)
)`,
  `CREATE TABLE IF NOT EXISTS shop_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  energy_spent INT,
  rmb_amount NUMERIC(10,2),
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE INDEX IF NOT EXISTS idx_shop_orders_user
  ON shop_orders (user_id, created_at DESC)`,

  // === P3: Social + Push ===
  `CREATE TABLE IF NOT EXISTS friendships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, friend_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships (user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships (friend_id, status)`,

  `CREATE TABLE IF NOT EXISTS dream_bottles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    mood_tags TEXT[] DEFAULT '{}',
    bottle_type TEXT NOT NULL DEFAULT 'random' CHECK (bottle_type IN ('random', 'directed')),
    recipient_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'floating' CHECK (status IN ('floating', 'picked', 'replied', 'archived')),
    picked_by UUID REFERENCES users(id) ON DELETE SET NULL,
    picked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bottles_sender ON dream_bottles (sender_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_bottles_status ON dream_bottles (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_bottles_picked ON dream_bottles (picked_by, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS bottle_replies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bottle_id UUID NOT NULL REFERENCES dream_bottles(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_replies_bottle ON bottle_replies (bottle_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS bottle_reads (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bottle_id UUID NOT NULL REFERENCES dream_bottles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, bottle_id)
  )`,

  `CREATE TABLE IF NOT EXISTS feed_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'milestone' CHECK (type IN ('milestone', 'dream_share', 'check_in', 'achievement')),
    content_json JSONB NOT NULL DEFAULT '{}',
    like_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_feed_created ON feed_posts (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_feed_user ON feed_posts (user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS feed_likes (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, post_id)
  )`,

  `CREATE TABLE IF NOT EXISTS push_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
    token TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, platform, token)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_push_user ON push_devices (user_id, platform)`,

  `CREATE TABLE IF NOT EXISTS push_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data_json JSONB DEFAULT '{}',
    sent_at TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_push_queue_sent ON push_queue (sent_at, created_at)`,

  `CREATE TABLE IF NOT EXISTS job_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL CHECK (type IN ('bottle_deliver', 'push_notify', 'feed_notify')),
    payload_json JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    attempts INT NOT NULL DEFAULT 0,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_job_queue_pending ON job_queue (status, scheduled_at)`,

  // === 生物雷达（OmeSoft 云端推送）===
  `CREATE TABLE IF NOT EXISTS radar_realtime_latest (
    mac TEXT PRIMARY KEY,
    radar_number INT,
    heart_rate INT,
    respiratory_rate INT,
    isbed INT,
    signal INT,
    alarm_type INT,
    online INT,
    time_stamp TIMESTAMPTZ,
    raw_json JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_radar_realtime_updated ON radar_realtime_latest (updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS radar_sleep_reports (
    sleep_id TEXT PRIMARY KEY,
    mac TEXT NOT NULL,
    inbed_time INT,
    outbed_time INT,
    deep_sleeptime INT,
    light_sleeptime INT,
    rem_time INT,
    wake_time INT,
    sleep_score INT,
    sdate TIMESTAMPTZ,
    edate TIMESTAMPTZ,
    assess_json JSONB,
    heartlist_json JSONB,
    resplist_json JSONB,
    datelist_json JSONB,
    raw_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_radar_reports_mac ON radar_sleep_reports (mac, created_at DESC)`,

  // === 手机号短信登录 ===
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users (phone) WHERE phone IS NOT NULL AND deleted_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS sms_verification_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'login',
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    attempt_count INT NOT NULL DEFAULT 0,
    request_ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sms_codes_phone_created ON sms_verification_codes (phone, created_at DESC)`,

  // === 微信登录 ===
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS wechat_unionid TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS wechat_openid TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wechat_unionid ON users (wechat_unionid) WHERE wechat_unionid IS NOT NULL AND deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wechat_openid ON users (wechat_openid) WHERE wechat_openid IS NOT NULL AND deleted_at IS NULL`,

  // === 用户状态（管理端）===
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_reason TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_users_status_created ON users (status, created_at DESC)`,

  // === 用户头像（微信等）===
  `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT`,

  // === 管理端：角色 / 管理员 / 审计 ===
  `CREATE TABLE IF NOT EXISTS admin_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    permissions_json JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    role_id UUID NOT NULL REFERENCES admin_roles(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_users_role ON admin_users (role_id)`,
  `CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    before_json JSONB,
    after_json JSONB,
    ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_admin_audit_resource ON admin_audit_logs (resource_type, resource_id)`,
];

async function main() {
  for (const sql of MIGRATION_STATEMENTS) {
    try {
      await query(sql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (sql.includes('pgcrypto') && message.includes('extension')) {
        console.warn('Skip pgcrypto extension (not required if gen_random_uuid works)');
        continue;
      }
      throw err;
    }
  }
  console.log('Migration complete.');
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
