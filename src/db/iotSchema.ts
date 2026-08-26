/** Keep in sync with sleep-mqtt/auth/src/schema.ts */
export const IOT_MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS iot_products (
    product_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
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
  `CREATE TABLE IF NOT EXISTS iot_messages_latest (
    sn TEXT NOT NULL,
    topic TEXT NOT NULL,
    product_key TEXT NOT NULL,
    raw_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sn, topic)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_iot_latest_sn_time ON iot_messages_latest (sn, received_at DESC)`,
];
