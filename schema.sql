-- AT Protocol PDS Schema for D1

-- Records table: stores all repo records (posts, likes, follows, etc.)
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection TEXT NOT NULL,           -- e.g., app.bsky.feed.post
  rkey TEXT NOT NULL,                 -- record key (usually TID)
  record TEXT NOT NULL,               -- JSON record content
  cid TEXT,                           -- content identifier (hash)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(collection, rkey)
);

CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at DESC);

-- Sequences table: event log for firehose (subscribeRepos)
CREATE TABLE IF NOT EXISTS sequences (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,           -- commit, identity, account, sync
  did TEXT NOT NULL,
  event TEXT NOT NULL,                -- CBOR-encodable event data as JSON
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sequences_created ON sequences(created_at);

-- Interactions table: cached interactions from upstream (likes, reposts on your posts)
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uri TEXT NOT NULL UNIQUE,           -- at://did/collection/rkey
  type TEXT NOT NULL,                 -- like, repost, reply
  actor_did TEXT NOT NULL,
  actor_handle TEXT,
  target_uri TEXT NOT NULL,           -- the post being interacted with
  record TEXT,                        -- full interaction record
  indexed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_interactions_target ON interactions(target_uri);
CREATE INDEX IF NOT EXISTS idx_interactions_type ON interactions(type);

-- Blobs table: blob metadata (images, etc.)
CREATE TABLE IF NOT EXISTS blobs (
  cid TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
