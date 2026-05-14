# Solana Data Farmer API

A Railway-ready Solana data indexing API for MySQL-backed projects.

It watches Solana wallets, programs, mints, or accounts, pulls parsed transactions from RPC, stores the full raw transaction JSON, and extracts common query surfaces:

- native SOL transfers
- SPL token transfers
- NFT-like mint/transfer/burn events
- program instructions and logs
- native balance changes
- token balance snapshots
- sync status and run history

## Quick Start

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
```

Add a watched address:

```bash
curl -X POST http://localhost:3000/api/watch/addresses \
  -H "Content-Type: application/json" \
  -d '{"address":"YOUR_SOLANA_ADDRESS","kind":"wallet","label":"main wallet"}'
```

Run a sync:

```bash
curl -X POST http://localhost:3000/api/sync/run \
  -H "Content-Type: application/json" \
  -d '{"address":"YOUR_SOLANA_ADDRESS","limit":25}'
```

Query data:

```bash
curl http://localhost:3000/api/wallets/YOUR_SOLANA_ADDRESS/summary
curl http://localhost:3000/api/transactions?address=YOUR_SOLANA_ADDRESS
curl http://localhost:3000/api/transfers/tokens?address=YOUR_SOLANA_ADDRESS
curl http://localhost:3000/api/program-events?programId=PROGRAM_ID
```

If `API_KEY` is set, send it as `x-api-key: your-key` or `Authorization: Bearer your-key`.

## Railway Setup

1. Create a new Railway project.
2. Add a MySQL service.
3. Add this repo as a Railway service.
4. Set:
   - `SOLANA_RPC_URL`
   - `API_KEY`
   - `ENABLE_SYNC_LOOP=true` if you want the web process to sync in the background
5. Railway should provide `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD`, and `MYSQLDATABASE`.

The included `railway.json` runs migrations before starting the API.

For larger indexing, run `npm run worker` as a separate Railway service so API requests stay fast.

## API

### Health

- `GET /health`

### Watch List

- `GET /api/watch/addresses`
- `POST /api/watch/addresses`
- `DELETE /api/watch/addresses/:address`

Body for `POST /api/watch/addresses`:

```json
{
  "address": "Solana public key",
  "kind": "wallet",
  "label": "optional label"
}
```

Allowed kinds: `wallet`, `program`, `mint`, `account`.

### Sync

- `POST /api/sync/run`

Sync one address:

```json
{
  "address": "Solana public key",
  "limit": 50
}
```

Sync all enabled watched addresses:

```json
{
  "limit": 50
}
```

### Query

- `GET /api/status`
- `GET /api/wallets/:address/summary`
- `GET /api/wallets/:address/transactions`
- `GET /api/wallets/:address/transfers`
- `GET /api/transactions`
- `GET /api/transactions/:signature`
- `GET /api/transfers/native`
- `GET /api/transfers/tokens`
- `GET /api/nfts/events`
- `GET /api/program-events`

Most list endpoints accept `limit`. Address-aware endpoints accept `address`; token endpoints accept `mint`; program event endpoints accept `programId`.

## Notes

Solana does not expose one universal "all chain data" feed over normal public RPC. This service is built around watched addresses and programs, which is the practical shape for product APIs. The raw transaction JSON is stored for every indexed transaction so you can add more parsers later without losing source fidelity.
