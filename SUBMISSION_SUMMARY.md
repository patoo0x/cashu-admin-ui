# Cashu Nutshell Admin UI — Bounty Submission

The Cashu Nutshell Admin UI is a standalone web dashboard for managing Cashu mints. It runs as a separate Node.js daemon that connects to a Nutshell mint's API, providing a modern dark-themed interface for configuring settings, monitoring activity in real time, managing keysets, and performing admin operations like key rotation and free minting. The frontend is a zero-dependency vanilla HTML/CSS/JS SPA; the backend is a lightweight Express server with WebSocket support for live updates.

## Bounty Requirements — Coverage

### 1. Change settings of the mint and apply them ✓
Tabbed settings UI covering: mint name, description, icon URL, TOS URL, MOTD, contact info, mint/melt/balance limits, rate limits, and Lightning fee configuration. All form fields are pre-populated from the live mint's `/v1/info` endpoint so the operator sees current values before editing.

### 2. Observe activity of the mint ✓
Real-time request monitoring via WebSocket (5-second push interval). Filterable activity log (mint/melt/swap/checkstate operations). Live log stream with level and source filters.

### 3. Basic monitoring properties ✓

**Number of entries in the database:** Direct read-only SQLite inspection via the system `sqlite3` CLI. The Database page shows entry counts for every core Nutshell table:
- `mint_quotes` — NUT-04 mint requests (total + breakdown by state: UNPAID/PAID/ISSUED/EXPIRED)
- `melt_quotes` — NUT-05 melt requests (total + breakdown by state: UNPAID/PENDING/PAID)
- `proofs` — Spent proof set (double-spend prevention)
- `outputs` — Blind signatures issued (promises to token holders)
- `keysets` — Keyset history (total + active count)

**Number of requests in recent past:** Derived from `created_time` timestamps in the `mint_quotes` and `melt_quotes` tables — trailing 1h and 24h windows shown on the Database page and dashboard.

**Free disk space:** OS disk stats via `df -k /` displayed on the dashboard with progress bars and color thresholds.

**Used CPU by nutshell:** OS-level CPU usage tracked and displayed. Also exposed as a Prometheus gauge for Grafana integration.

### 4. Admin-level actions ✓

**Key rotation:** Form-driven keyset rotation (unit, max order, input fee per kilo). Maps to `MintManagementRPC.RotateNextKeyset()`.

**Issuing ecash without requiring a payment:** Free mint modal — creates a NUT-04 quote and marks it as PAID without Lightning payment. Maps to `MintManagementRPC.UpdateNut04Quote(state=PAID)` followed by standard minting flow.

Additional admin actions: quote state overrides (NUT-04/NUT-05), cache clearing, mint restart and update management.

## Technical Details

- **No build step** — vanilla HTML/CSS/JS frontend
- **No native dependencies** — SQLite inspection uses the system `sqlite3` CLI (available wherever Nutshell runs)
- **Prometheus `/metrics` endpoint** — includes DB entry count gauges (`cashu_mint_db_entries_total`, `cashu_mint_db_quotes_by_state`)
- **Docker ready** — Dockerfile and docker-compose.yml for one-command deployment
- **Code comments** reference NUT spec numbers and Nutshell source files (`settings.py`, `management_rpc.py`, `crud.py`)

Set `MINT_DB_PATH` in your `.env` to enable the Database page (path to Nutshell's `cashu.db`). See README for full configuration and API reference.
