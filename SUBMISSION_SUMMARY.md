# Cashu Nutshell Admin UI — Bounty Submission

The Cashu Nutshell Admin UI is a standalone web dashboard for managing Cashu mints. It runs as a separate Node.js daemon that connects to a Nutshell mint's API, providing a modern dark-themed interface for configuring settings, monitoring activity in real time, managing keysets, and performing admin operations like key rotation and free minting. The frontend is a zero-dependency vanilla HTML/CSS/JS SPA; the backend is a lightweight Express server with WebSocket support for live updates.

This addresses the core bounty requirements: mint operators can change settings (name, limits, fees, contact info, MOTD), observe mint activity with real-time request tracking, monitor system resources, trigger key rotation, and issue ecash without payment — all from the browser. The project includes Docker support with a compose file that spins up both the admin UI and a Nutshell mint, making it easy to evaluate. Authentication is handled via HTTP Basic Auth with configurable credentials.

The full source, documentation, and Docker configuration are in the repository. See the [README](README.md) for setup instructions, API documentation, and architecture details.
