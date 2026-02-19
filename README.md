# Cashu Nutshell Admin UI

A modern, dark-themed admin dashboard for managing Cashu Nutshell mints. This UI provides comprehensive mint management capabilities including monitoring, settings configuration, key rotation, and admin operations like issuing ecash without payment.

![Dashboard Preview](https://via.placeholder.com/800x400?text=Cashu+Admin+UI+Dashboard)

## Features

### 📊 Dashboard
- Real-time mint status overview
- Active keysets count
- System resource monitoring (memory, CPU)
- Mint information display

### 📈 Monitoring
- Live request tracking
- Operation type breakdown (mint, melt, swap, checkstate)
- Recent requests table with timestamps
- Simulate activity for testing

### ⚙️ Settings Management
- **Mint Info**: Name, description, icon, TOS URL
- **Limits**: Max mint/melt amounts, rate limiting
- **Fees**: Lightning fee percentage, reserve minimum
- **Contact**: Email, Twitter, Telegram, Nostr, MOTD

### 🔑 Keyset Management
- View all active keysets
- Perform key rotation with custom parameters
- Input fee configuration

### 🔧 Admin Actions
- **Key Rotation**: Rotate to new keysets for improved security
- **Free Mint**: Issue ecash without Lightning payment (use with caution!)
- **Quote Management**: Manually update mint/melt quote states
- **Cache Clearing**: Clear Redis cache and monitoring data

### 📋 Activity Log
- Complete transaction history
- Filter by operation type
- IP address tracking

## Requirements

- Node.js 16+ 
- Cashu Nutshell mint running (optional, for full functionality)
- Access to mint API (REST at port 3338, gRPC at port 8086)

## Installation

```bash
# Clone or navigate to the project directory
cd /Users/dread/.openclaw/workspace/cashu-admin-ui

# Install dependencies
npm install
```

## Configuration

Set environment variables to customize the admin UI:

```bash
export PORT=3339                    # Admin UI port (default: 3339)
export MINT_URL=http://127.0.0.1:3338  # Mint API URL
export MINT_GRPC_PORT=8086          # Mint gRPC port
export ADMIN_USER=admin             # Admin username
export ADMIN_PASS=your_secure_pass  # Admin password
export AUTH_TYPE=basic              # 'basic', 'token', or 'none'
```

Or create a `.env` file:

```env
PORT=3339
MINT_URL=http://127.0.0.1:3338
MINT_GRPC_PORT=8086
ADMIN_USER=admin
ADMIN_PASS=admin123
AUTH_TYPE=basic
```

## Usage

### Start the Admin UI

```bash
npm start
```

The admin UI will be available at `http://localhost:3339`

### Default Login

- **Username**: `admin`
- **Password**: `admin123`

Change these via environment variables for production use.

## API Endpoints

### Mint API (Proxied)

| Endpoint | Description |
|----------|-------------|
| `GET /api/mint/info` | Mint information |
| `GET /api/mint/keys` | Public keys |
| `GET /api/mint/keysets` | Active keysets |

### Admin API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/admin/dashboard` | GET | Dashboard overview |
| `GET /api/admin/system` | GET | System statistics |
| `GET /api/admin/monitoring` | GET | Monitoring data |
| `POST /api/admin/monitoring/clear` | POST | Clear monitoring data |
| `GET /api/admin/settings` | GET | Current settings |
| `POST /api/admin/settings/info` | POST | Update mint info |
| `POST /api/admin/settings/motd` | POST | Update MOTD |
| `POST /api/admin/settings/limits` | POST | Update limits |
| `POST /api/admin/settings/fees` | POST | Update fees |
| `POST /api/admin/settings/contact` | POST | Update contact info |
| `POST /api/admin/keyset/rotate` | POST | Rotate keyset |
| `POST /api/admin/mint/free` | POST | Mint ecash without payment |
| `POST /api/admin/quote/mint` | POST | Update mint quote state |
| `POST /api/admin/quote/melt` | POST | Update melt quote state |
| `GET /api/admin/activity` | GET | Activity log |
| `POST /api/admin/activity/simulate` | POST | Simulate activity |

### WebSocket

Connect to `ws://localhost:3339` for real-time updates:

```json
{
  "type": "stats",
  "data": {
    "memory": { ... },
    "uptime": 1234,
    "requests": [ ... ],
    "timestamp": 1234567890
  }
}
```

## Integration with Nutshell Mint

### Enabling gRPC Management Server

For full admin functionality, enable the gRPC server in your Nutshell `.env`:

```env
MINT_RPC_SERVER_ENABLE=true
MINT_RPC_SERVER_ADDR=localhost
MINT_RPC_SERVER_PORT=8086
MINT_RPC_SERVER_CA=./ca_cert.pem
MINT_RPC_SERVER_CERT=./server_cert.pem
MINT_RPC_SERVER_KEY=./server_key.pem
MINT_RPC_SERVER_MUTUAL_TLS=true
```

### Using with Docker

```bash
# Run Cashu Admin UI
docker run -d \
  -p 3339:3339 \
  -e MINT_URL=http://mint:3338 \
  -e ADMIN_USER=admin \
  -e ADMIN_PASS=securepassword \
  cashu-admin-ui

# Run alongside your mint
docker compose up -d
```

## Security Considerations

⚠️ **Important Security Notes:**

1. **Default Credentials**: Change default admin credentials in production
2. **Network Isolation**: Run on internal network or behind VPN
3. **Authentication**: Enable `AUTH_TYPE=basic` for production
4. **TLS**: Use reverse proxy with HTTPS for production
5. **Free Mint**: The free mint feature bypasses payment - use with extreme caution!

## Development

```bash
# Run in development mode with auto-reload
npm run dev

# Access at http://localhost:3339
```

## Project Structure

```
cashu-admin-ui/
├── server.js           # Express server with API endpoints
├── package.json        # Dependencies and scripts
├── public/
│   ├── index.html      # Main HTML page
│   ├── styles.css      # Dark theme styles
│   └── app.js          # Frontend JavaScript
└── README.md            # This file
```

## Nutshell Bounty Compliance

This admin UI fulfills the requirements from the GitHub issue #556:

✅ **Change settings of the mint and apply them**
- Via Settings page with form inputs
- Note: Some settings require mint restart

✅ **Observe activity of the mint**
- Real-time monitoring via WebSocket
- Activity log with filtering

✅ **Basic monitoring (DB entries, requests, disk, CPU)**
- Request tracking and statistics
- System resource monitoring
- Activity table

✅ **Admin actions: trigger key rotation, issue ecash without payment**
- Key rotation with custom parameters
- Free mint modal for admin ecash issuance

✅ **Technical constraints met**
- Separate daemon (Node.js server)
- REST API communication with mint
- WebSocket for real-time updates
- Token/password authentication

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions are welcome! Please open issues or submit pull requests.

## Acknowledgments

- [Cashu](https://cashu.space/) - Chaumian Ecash protocol
- [Nutshell](https://github.com/cashubtc/nutshell) - Reference mint implementation
