# Shadow Player - Modern Edition

A minimal browser-based video player that mirrors Kodi playback. This is a modern rewrite of the original shadowPlayer addon.

## Features

- 🎬 Mirrors video playback from Kodi to any modern browser
- 🔄 Smooth playback synchronization using adaptive rate adjustment
- 📡 Real-time updates via WebSocket (with HTTP fallback)
- 📱 Works on any device with a modern web browser
- ⚡ No build step required - runs directly in browser

## Requirements

- Kodi 18 (Leia) or newer (tested up to Kodi 21 Omega)
- A modern web browser (Chrome, Firefox, Safari, Edge)
- Both devices on the same network

## Setup

### 1. Configure Kodi

Enable remote control in Kodi:

1. Go to **Settings** → **Services** → **Control**
2. Enable **"Allow remote control via HTTP"**
3. Set a **Port** (default: 8080)
4. Optionally set a username/password
5. Enable **"Allow remote control from applications on other systems"** if accessing from another device

### 2. Run Shadow Player

#### Option A: Serve locally
```bash
cd modern
python3 -m http.server 8000
```
Then open `http://localhost:8000` in your browser.

#### Option B: Install as Kodi Web Interface
Copy the `modern` folder to your Kodi addons directory as a web interface addon.

#### Option C: Use any static file server
The `modern` folder can be served by any web server (nginx, Apache, etc.)

### 3. Connect

1. Enter your Kodi device's IP address
2. Enter the HTTP port (default: 8080)
3. Click Connect
4. Start playing something in Kodi!

## How It Works

Shadow Player connects to Kodi's JSON-RPC API to:
1. Detect when media is playing
2. Get the media file URL via `Files.PrepareDownload`
3. Poll the current playback position every 250ms
4. Adjust the local video's playback rate to stay in sync

The sync algorithm uses adaptive rate adjustment:
- Small differences: Slightly speed up or slow down playback
- Large differences: Jump to the correct position
- Network jitter: Maintain normal speed to avoid stuttering

## Troubleshooting

### "Failed to connect to Kodi"
- Verify Kodi's IP address and port
- Check that HTTP control is enabled in Kodi
- Ensure both devices are on the same network
- Try disabling any firewall temporarily

### Video doesn't play
- Some media formats may not be supported by your browser
- Check browser console for errors
- Try a different browser (Chrome generally has best codec support)
- The media file must be accessible via HTTP from Kodi

### Playback is choppy or out of sync
- Check your network connection
- Double-click the video to show sync stats
- High "lag" values indicate network latency issues

## API Methods Used

| Method | Purpose |
|--------|---------|
| `JSONRPC.Version` | Test connection |
| `Player.GetActivePlayers` | Find active player |
| `Player.GetProperties` | Get time, speed, etc. |
| `Player.GetItem` | Get current media info |
| `Files.PrepareDownload` | Get media file URL |
| `Player.PlayPause` | Toggle playback |
| `Player.Seek` | Seek to position |

## Files

```
modern/
├── index.html      # Main UI
└── js/
    ├── app.js          # Main application logic
    ├── kodi-rpc.js     # Kodi JSON-RPC client
    └── sync-engine.js  # Playback synchronization
```

## Credits

- Original shadowPlayer by [Samuel Bailey](https://bailey.geek.nz)
- Sync algorithm preserved from the original implementation
- Kodi JSON-RPC API documentation: https://kodi.wiki/view/JSON-RPC_API

## License

GPL-3.0 (same as original)
