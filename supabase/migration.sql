-- Blaze Supabase Migration
-- Users and trades live here (survives Render restarts).
-- SQLite (player_markets, player_id_map, player_goals) is managed by the app, not here.

-- Destroy all existing tables
DROP TABLE IF EXISTS blaze_users CASCADE;
DROP TABLE IF EXISTS blaze_trades CASCADE;

-- Users: Telegram onboarding + Polymarket credentials
CREATE TABLE blaze_users (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL UNIQUE,
  wallet_address TEXT,
  encrypted_private_key TEXT,
  encrypted_api_key TEXT,
  encrypted_api_secret TEXT,
  encrypted_passphrase TEXT,
  funder_address TEXT,
  threshold DOUBLE PRECISION DEFAULT 0.99,
  bet_size DOUBLE PRECISION DEFAULT 10,
  max_exposure DOUBLE PRECISION DEFAULT 100,
  pending_threshold DOUBLE PRECISION,
  pending_bet_size DOUBLE PRECISION,
  pending_max_exposure DOUBLE PRECISION,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_blaze_users_chat ON blaze_users(chat_id);

-- Trades: every FAK order placed
CREATE TABLE blaze_trades (
  id BIGSERIAL PRIMARY KEY,
  fixture_id BIGINT NOT NULL,
  player_name TEXT NOT NULL,
  market_id TEXT NOT NULL,
  token_id TEXT,
  user_chat_id BIGINT REFERENCES blaze_users(chat_id),
  action TEXT NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  size DOUBLE PRECISION NOT NULL,
  cost DOUBLE PRECISION NOT NULL,
  order_id TEXT,
  status TEXT DEFAULT 'pending',
  pnl DOUBLE PRECISION DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_blaze_trades_status ON blaze_trades(status);
CREATE INDEX idx_blaze_trades_user ON blaze_trades(user_chat_id);
CREATE INDEX idx_blaze_trades_fixture ON blaze_trades(fixture_id);
CREATE INDEX idx_blaze_trades_player ON blaze_trades(player_name);
