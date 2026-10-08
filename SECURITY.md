# Security

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/uberblick-ai/uberblick-2/security/advisories/new).
Use that private channel rather than a public issue or pull request.

The supported hub deployment is a published Docker release on Linux x86_64,
or Docker Desktop on macOS. Apple Silicon Macs use `linux/amd64` emulation.
The default deployment serves HTTP on host loopback only. Connections from
other computers require HTTPS with public DNS or the supported Tailscale route.
Remote sync admits only device credentials with current workspace membership.
See [REMOTE.md](REMOTE.md) for the supported deployment and access boundaries.
