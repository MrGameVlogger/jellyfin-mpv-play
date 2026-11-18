# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.18.x  | Yes       |
| 1.17.x  | Yes       |
| < 1.17  | No        |
| 1.9.x   | No        |
| 1.8.x   | No        |
| 1.7.x   | No        |
| 1.6.x   | No        |
| 1.5.x   | No        |
| 1.4.x   | No        |
| 1.3.x   | No        |
| 1.2.x   | No        |

## Reporting a Vulnerability

If you find a security issue, please report it privately:

1. **Do NOT open a public issue**
2. Email: [Use GitHub's private vulnerability reporting](https://github.com/MrGameVlogger/jellyfin-mpv-play/security/advisories/new)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact

## Security Notes

- `config.js` contains your Jellyfin password in plain text — never share it
- The app connects to your local Jellyfin server over HTTP/HTTPS
- The Unix socket at `/tmp/mpv-ipc.sock` is world-readable by default
- The app is not sandboxed (it spawns child processes and connects to network)
