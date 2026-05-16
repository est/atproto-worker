## Project Goal: Event-Sourced Static ATProto Publisher

### One-sentence goal

Build a **minimal ATProto PDS publisher** that uses a **static, append-only, pre-signed event journal** as the single source of truth, with a **stateless worker** that publishes those events to the ATProto network.

---

## Core Idea

This project replaces a traditional dynamic PDS with:

* A **local event-sourced journal** (append-only file)
* **Pre-signed commits** generated offline
* A **stateless Cloudflare Worker** that:

  * Reads the journal
  * Derives sequence numbers deterministically
  * Emits valid ATProto commits/firehose events

No database.
No mutable state.
No signing keys on the server.

---

## Architecture Overview

```
Local authoring machine
  └─ generate record
  └─ canonical CBOR encode
  └─ compute CID
  └─ sign commit
  └─ append event to journal

Static hosting (GitHub Pages / CF Pages / S3)
  └─ serves immutable journal file

Cloudflare Worker
  └─ fetch journal via HTTP / Range
  └─ parse events sequentially
  └─ derive seq from byte offsets
  └─ publish commits to ATProto relays
  └─ revieve interactions from ATProto networks
```

---

## Journal (Append-Only Log)

* **Single source of truth**
* **Append-only**
* **Immutable**
* **Pre-signed**
* One event per line (JSON or CBOR)

Each event contains:

* Record data
* CID (content-addressed)
* `prev` commit CID
* Signature
* Operation type (create/update/delete)

The journal is **never rewritten**.

---

## Event Sourcing Model

* Journal = event log
* Current “state” = derived by replay
* Worker = projection/publisher
* Relays/subscribers can replay from any sequence number

This mirrors:

* Datomic’s **journal**
* Event sourcing systems
* Commit logs (Kafka/Raft-style)
* WAL in InnoDB/Postgress/Redis

---

## Sequence Numbers (`seq`)

* `seq` is **monotonic**
* Derived from **byte offset in the journal**
* Deterministic
* No persistent worker state required
* Supports HTTP Range requests

---

## Security Model

* Private keys **never leave the local machine**
* Worker never signs anything
* All cryptographic verification is end-to-end
* Hosting provider is fully untrusted

---

## Constraints / Non-Goals

* No mutable edits (immutability by design)
* No concurrent writers
* No dynamic server-side signing
* No traditional database

---

## Why This Exists

* Run an ATProto publisher **for free**
* Minimize operational complexity
* Align with ATProto’s immutable, DAG-based design
* Make PDS publishing closer to **static site generation**
* Leverage event sourcing instead of stateful services

---

## Mental Model (for AI tools)

> “Treat the journal as an immutable event log.
> Never mutate it.
> Never infer hidden state.
> Always derive everything by replay.”
