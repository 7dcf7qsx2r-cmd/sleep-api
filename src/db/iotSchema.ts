/** Keep in sync with sleep-mqtt/auth/src/schema.ts */
export const IOT_MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS iot_products (
    product_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `ALTER TABLE iot_products ADD COLUMN IF NOT EXISTS product_secret TEXT`,
  `CREATE TABLE IF NOT EXISTS iot_devices (
    sn TEXT PRIMARY KEY,
    product_key TEXT NOT NULL REFERENCES iot_products(product_key),
    device_secret TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_iot_devices_product ON iot_devices (product_key)`,
  `CREATE TABLE IF NOT EXISTS iot_device_bindings (
    product_key TEXT NOT NULL,
    sn TEXT NOT NULL,
    user_id UUID NOT NULL,
    alias TEXT,
    model TEXT,
    bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (product_key, sn)
  )`,
  `ALTER TABLE iot_device_bindings ADD COLUMN IF NOT EXISTS model TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_iot_bindings_user ON iot_device_bindings (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_iot_bindings_sn ON iot_device_bindings (sn)`,
  `CREATE TABLE IF NOT EXISTS iot_messages (
    id BIGSERIAL PRIMARY KEY,
    product_key TEXT NOT NULL,
    sn TEXT NOT NULL,
    topic TEXT NOT NULL,
    raw_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_iot_messages_sn_time ON iot_messages (sn, received_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_iot_messages_sn_id ON iot_messages (sn, id)`,
  `CREATE INDEX IF NOT EXISTS idx_iot_messages_sn_sleep ON iot_messages (sn, received_at DESC)
    WHERE raw_json->'params'->'SleepReportNew' IS NOT NULL
       OR raw_json->'params'->'sleepReportNew' IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_iot_messages_sn_config ON iot_messages (sn, received_at DESC)
    WHERE raw_json->'params'->'characteristic' IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS iot_messages_latest (
    sn TEXT NOT NULL,
    topic TEXT NOT NULL,
    product_key TEXT NOT NULL,
    raw_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sn, topic)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_iot_latest_sn_time ON iot_messages_latest (sn, received_at DESC)`,
  `CREATE TABLE IF NOT EXISTS iot_sleep_epochs (
    sn TEXT NOT NULL,
    epoch_start TIMESTAMPTZ NOT NULL,
    product_key TEXT NOT NULL DEFAULT 'cis_ip',
    night_date DATE NOT NULL,
    sample_count INT NOT NULL DEFAULT 0,
    in_bed_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
    hr_mean DOUBLE PRECISION,
    hr_min DOUBLE PRECISION,
    hr_std DOUBLE PRECISION,
    br_mean DOUBLE PRECISION,
    br_std DOUBLE PRECISION,
    p_mean DOUBLE PRECISION,
    motion DOUBLE PRECISION NOT NULL DEFAULT 0,
    snore_count INT,
    snore_db_max DOUBLE PRECISION,
    moving_flag SMALLINT NOT NULL DEFAULT 0,
    quality TEXT NOT NULL DEFAULT 'ok',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sn, epoch_start)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_iot_sleep_epochs_sn_night ON iot_sleep_epochs (sn, night_date, epoch_start)`,
  `CREATE TABLE IF NOT EXISTS iot_sleep_epoch_cursor (
    sn TEXT PRIMARY KEY,
    last_message_id BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS iot_sleep_sessions (
    sn TEXT NOT NULL,
    night_date DATE NOT NULL,
    product_key TEXT NOT NULL DEFAULT 'cis_ip',
    sleep_start TIMESTAMPTZ,
    sleep_end TIMESTAMPTZ,
    duration_minutes INT NOT NULL DEFAULT 0,
    deep_minutes INT NOT NULL DEFAULT 0,
    light_minutes INT NOT NULL DEFAULT 0,
    rem_minutes INT NOT NULL DEFAULT 0,
    awake_minutes INT NOT NULL DEFAULT 0,
    awakenings INT NOT NULL DEFAULT 0,
    avg_heart_rate DOUBLE PRECISION,
    avg_breath_rate DOUBLE PRECISION,
    confidence TEXT NOT NULL DEFAULT 'low',
    source TEXT NOT NULL DEFAULT 'cis_ip',
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sn, night_date)
  )`,
];
