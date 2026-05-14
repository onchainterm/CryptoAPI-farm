CREATE TABLE IF NOT EXISTS watched_addresses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  address VARCHAR(64) NOT NULL,
  kind ENUM('wallet', 'program', 'mint', 'account') NOT NULL DEFAULT 'wallet',
  label VARCHAR(160) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  last_signature VARCHAR(100) NULL,
  last_synced_slot BIGINT UNSIGNED NULL,
  last_synced_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_watched_address (address),
  KEY idx_watched_enabled (enabled, kind)
);

CREATE TABLE IF NOT EXISTS transactions (
  signature VARCHAR(100) NOT NULL,
  slot BIGINT UNSIGNED NOT NULL,
  block_time DATETIME NULL,
  status ENUM('success', 'failed') NOT NULL,
  fee_lamports BIGINT UNSIGNED NULL,
  tx_error_json JSON NULL,
  raw_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (signature),
  KEY idx_transactions_slot (slot),
  KEY idx_transactions_block_time (block_time),
  KEY idx_transactions_status (status)
);

CREATE TABLE IF NOT EXISTS address_transactions (
  address VARCHAR(64) NOT NULL,
  signature VARCHAR(100) NOT NULL,
  slot BIGINT UNSIGNED NOT NULL,
  role ENUM('watched', 'account_key', 'program', 'mint', 'unknown') NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (address, signature),
  KEY idx_address_transactions_signature (signature),
  KEY idx_address_transactions_slot (address, slot),
  CONSTRAINT fk_address_transactions_signature
    FOREIGN KEY (signature) REFERENCES transactions(signature)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS native_transfers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  signature VARCHAR(100) NOT NULL,
  slot BIGINT UNSIGNED NOT NULL,
  block_time DATETIME NULL,
  instruction_index INT NOT NULL,
  inner_index INT NOT NULL DEFAULT -1,
  transfer_order INT NOT NULL,
  from_address VARCHAR(64) NULL,
  to_address VARCHAR(64) NULL,
  lamports BIGINT UNSIGNED NOT NULL,
  sol DECIMAL(32, 12) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_native_transfer (signature, instruction_index, inner_index, transfer_order),
  KEY idx_native_from (from_address, slot),
  KEY idx_native_to (to_address, slot),
  CONSTRAINT fk_native_transfers_signature
    FOREIGN KEY (signature) REFERENCES transactions(signature)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS token_transfers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  signature VARCHAR(100) NOT NULL,
  slot BIGINT UNSIGNED NOT NULL,
  block_time DATETIME NULL,
  instruction_index INT NOT NULL,
  inner_index INT NOT NULL DEFAULT -1,
  transfer_order INT NOT NULL,
  mint VARCHAR(64) NULL,
  source_account VARCHAR(64) NULL,
  destination_account VARCHAR(64) NULL,
  source_owner VARCHAR(64) NULL,
  destination_owner VARCHAR(64) NULL,
  authority VARCHAR(64) NULL,
  amount_raw VARCHAR(90) NULL,
  amount DECIMAL(65, 30) NULL,
  decimals INT NULL,
  token_program VARCHAR(64) NULL,
  instruction_type VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_token_transfer (signature, instruction_index, inner_index, transfer_order),
  KEY idx_token_mint (mint, slot),
  KEY idx_token_source_owner (source_owner, slot),
  KEY idx_token_destination_owner (destination_owner, slot),
  KEY idx_token_source_account (source_account, slot),
  KEY idx_token_destination_account (destination_account, slot),
  CONSTRAINT fk_token_transfers_signature
    FOREIGN KEY (signature) REFERENCES transactions(signature)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS nft_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  signature VARCHAR(100) NOT NULL,
  slot BIGINT UNSIGNED NOT NULL,
  block_time DATETIME NULL,
  instruction_index INT NOT NULL,
  inner_index INT NOT NULL DEFAULT -1,
  transfer_order INT NOT NULL,
  mint VARCHAR(64) NULL,
  owner VARCHAR(64) NULL,
  from_owner VARCHAR(64) NULL,
  to_owner VARCHAR(64) NULL,
  event_type ENUM('mint', 'transfer', 'burn', 'unknown') NOT NULL DEFAULT 'unknown',
  metadata_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_nft_event (signature, instruction_index, inner_index, transfer_order),
  KEY idx_nft_mint (mint, slot),
  KEY idx_nft_owner (owner, slot),
  CONSTRAINT fk_nft_events_signature
    FOREIGN KEY (signature) REFERENCES transactions(signature)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS program_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  signature VARCHAR(100) NOT NULL,
  slot BIGINT UNSIGNED NOT NULL,
  block_time DATETIME NULL,
  instruction_index INT NOT NULL,
  inner_index INT NOT NULL DEFAULT -1,
  program_id VARCHAR(64) NOT NULL,
  program_name VARCHAR(80) NULL,
  instruction_type VARCHAR(120) NOT NULL,
  parsed_json JSON NULL,
  logs_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_program_event (signature, instruction_index, inner_index),
  KEY idx_program_events_program (program_id, slot),
  CONSTRAINT fk_program_events_signature
    FOREIGN KEY (signature) REFERENCES transactions(signature)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS balance_changes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  signature VARCHAR(100) NOT NULL,
  slot BIGINT UNSIGNED NOT NULL,
  account_index INT NOT NULL,
  account_address VARCHAR(64) NOT NULL,
  pre_lamports BIGINT UNSIGNED NOT NULL,
  post_lamports BIGINT UNSIGNED NOT NULL,
  delta_lamports BIGINT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_balance_change (signature, account_index),
  KEY idx_balance_changes_account (account_address, slot),
  CONSTRAINT fk_balance_changes_signature
    FOREIGN KEY (signature) REFERENCES transactions(signature)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS token_balances (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  signature VARCHAR(100) NOT NULL,
  slot BIGINT UNSIGNED NOT NULL,
  block_time DATETIME NULL,
  balance_side ENUM('pre', 'post') NOT NULL,
  account_index INT NOT NULL,
  account_address VARCHAR(64) NULL,
  mint VARCHAR(64) NOT NULL,
  owner VARCHAR(64) NULL,
  amount_raw VARCHAR(90) NOT NULL,
  ui_amount DECIMAL(65, 30) NULL,
  decimals INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_token_balance (signature, balance_side, account_index, mint),
  KEY idx_token_balances_owner (owner, mint, slot),
  KEY idx_token_balances_account (account_address, mint, slot),
  CONSTRAINT fk_token_balances_signature
    FOREIGN KEY (signature) REFERENCES transactions(signature)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  address VARCHAR(64) NULL,
  status ENUM('running', 'success', 'failed') NOT NULL DEFAULT 'running',
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  signatures_seen INT NOT NULL DEFAULT 0,
  transactions_indexed INT NOT NULL DEFAULT 0,
  error_message TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sync_runs_address (address, started_at),
  KEY idx_sync_runs_status (status, started_at)
);
