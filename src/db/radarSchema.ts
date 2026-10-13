/**
 * 生物雷达 / BR 系列床垫（OmeSoft 云端推送）表结构。
 * 双雷达设备（radarNumber 1/2 = 床的两侧）共用一个 MAC，实时与报告都按 (mac, radar_number) 区分。
 */
export const RADAR_MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS radar_realtime_latest (
    mac TEXT NOT NULL,
    radar_number INT NOT NULL DEFAULT 1,
    heart_rate INT,
    respiratory_rate INT,
    isbed INT,
    signal INT,
    alarm_type INT,
    online INT,
    time_stamp TIMESTAMPTZ,
    raw_json JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (mac, radar_number)
  )`,
  `UPDATE radar_realtime_latest SET radar_number = 1 WHERE radar_number IS NULL`,
  `ALTER TABLE radar_realtime_latest ALTER COLUMN radar_number SET DEFAULT 1`,
  `ALTER TABLE radar_realtime_latest ALTER COLUMN radar_number SET NOT NULL`,
  // 旧库主键只有 mac：双雷达两侧会互相覆盖，升级为 (mac, radar_number)
  `DO $$
  DECLARE pk_name TEXT;
  BEGIN
    SELECT c.conname INTO pk_name
    FROM pg_constraint c
    WHERE c.conrelid = 'radar_realtime_latest'::regclass
      AND c.contype = 'p'
      AND array_length(c.conkey, 1) = 1;
    IF pk_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE radar_realtime_latest DROP CONSTRAINT %I', pk_name);
      ALTER TABLE radar_realtime_latest ADD PRIMARY KEY (mac, radar_number);
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS idx_radar_realtime_updated ON radar_realtime_latest (updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS radar_sleep_reports (
    sleep_id TEXT PRIMARY KEY,
    mac TEXT NOT NULL,
    radar_number INT NOT NULL DEFAULT 1,
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
  `ALTER TABLE radar_sleep_reports ADD COLUMN IF NOT EXISTS radar_number INT NOT NULL DEFAULT 1`,
  `CREATE INDEX IF NOT EXISTS idx_radar_reports_mac ON radar_sleep_reports (mac, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_radar_reports_mac_radar ON radar_sleep_reports (mac, radar_number, created_at DESC)`,
];
