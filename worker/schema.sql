-- キレイン D1 スキーマ（Cloudflare D1 / SQLite）
-- 適用: wrangler d1 execute kirein --file=schema.sql

CREATE TABLE IF NOT EXISTS stores (
  id              TEXT PRIMARY KEY,   -- 店舗ID（place_id等）
  name            TEXT,
  place_id        TEXT,               -- Google Place ID（監視に使う）
  email           TEXT,               -- Ph2b: 決済時にStripeが取得した通知先メール
  stripe_customer TEXT,
  stripe_sub      TEXT,
  status          TEXT,               -- active | canceled
  created         TEXT,
  last_checked    TEXT                -- Ph2: 最後に口コミ監視した時刻
);
-- 既存D1に後から列を足す場合（初回CREATE後に一度だけ）:
--   wrangler d1 execute kirein --remote --command "ALTER TABLE stores ADD COLUMN email TEXT"

-- Ph2: 口コミ監視で検知した新規ネガのアラート
CREATE TABLE IF NOT EXISTS alerts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id  TEXT,
  quote     TEXT,                     -- 検知した口コミの一文
  area      TEXT,                     -- トイレ/におい 等
  detected  TEXT
);

-- Ph3: 店舗の対応公表（cert.html が読む）
CREATE TABLE IF NOT EXISTS responses (
  store_id  TEXT PRIMARY KEY,
  status    TEXT,                     -- responding | responded | rechecked
  comment   TEXT,
  updated   TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_store ON alerts(store_id);
CREATE INDEX IF NOT EXISTS idx_stores_status ON stores(status);
