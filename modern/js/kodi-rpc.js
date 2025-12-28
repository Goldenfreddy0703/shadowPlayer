/**
 * Kodi JSON-RPC Client
 * Supports both HTTP and WebSocket transports
 */

export class KodiRPC {
    constructor(host, httpPort = 8080, wsPort = 9090) {
        this.host = host;
        this.httpPort = httpPort;
        this.wsPort = wsPort;
        this.httpUrl = `http://${host}:${httpPort}/jsonrpc`;
        this.wsUrl = `ws://${host}:${wsPort}/jsonrpc`;
        this.vfsUrl = `http://${host}:${httpPort}/vfs/`;
        
        this.socket = null;
        this.messageId = 0;
        this.pendingMessages = new Map();
        this.notificationHandlers = new Map();
        this.transport = 'http';
        
        this.onConnect = null;
        this.onDisconnect = null;
    }

    /**
     * Connect to Kodi - first via HTTP, then upgrade to WebSocket
     */
    async connect() {
        // Test HTTP connection first
        try {
            const version = await this.sendHTTP('JSONRPC.Version');
            console.log('Kodi JSON-RPC version:', version.version);
            
            // Try to upgrade to WebSocket for real-time notifications
            this.tryWebSocket();
            
            return version;
        } catch (error) {
            throw new Error(`Failed to connect to Kodi at ${this.host}: ${error.message}`);
        }
    }

    /**
     * Attempt WebSocket connection for notifications
     */
    tryWebSocket() {
        try {
            this.socket = new WebSocket(this.wsUrl);
            
            this.socket.onopen = () => {
                console.log('WebSocket connected');
                this.transport = 'websocket';
                if (this.onConnect) this.onConnect();
            };
            
            this.socket.onmessage = (event) => {
                const data = JSON.parse(event.data);
                
                if (data.id !== undefined) {
                    // Response to a request
                    const pending = this.pendingMessages.get(data.id);
                    if (pending) {
                        pending.resolve(data);
                        this.pendingMessages.delete(data.id);
                    }
                } else if (data.method) {
                    // Notification
                    const handlers = this.notificationHandlers.get(data.method);
                    if (handlers) {
                        handlers.forEach(handler => handler(data.params));
                    }
                }
            };
            
            this.socket.onclose = () => {
                console.log('WebSocket disconnected');
                this.transport = 'http';
                this.socket = null;
                if (this.onDisconnect) this.onDisconnect();
                
                // Try to reconnect after 3 seconds
                setTimeout(() => this.tryWebSocket(), 3000);
            };
            
            this.socket.onerror = (error) => {
                console.warn('WebSocket error, falling back to HTTP polling');
            };
        } catch (e) {
            console.warn('WebSocket not available');
        }
    }

    /**
     * Send a JSON-RPC request via HTTP
     */
    async sendHTTP(method, params = {}) {
        const response = await fetch(this.httpUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method,
                params,
                id: ++this.messageId
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error.message || 'RPC Error');
        }
        
        return data.result;
    }

    /**
     * Send a JSON-RPC request via WebSocket
     */
    sendWS(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++this.messageId;
            
            this.pendingMessages.set(id, { resolve, reject });
            
            this.socket.send(JSON.stringify({
                jsonrpc: '2.0',
                method,
                params,
                id
            }));
            
            // Timeout after 5 seconds
            setTimeout(() => {
                if (this.pendingMessages.has(id)) {
                    this.pendingMessages.delete(id);
                    reject(new Error('Request timeout'));
                }
            }, 5000);
        });
    }

    /**
     * Send a request using the best available transport
     */
    async send(method, params = {}) {
        if (this.transport === 'websocket' && this.socket?.readyState === WebSocket.OPEN) {
            const response = await this.sendWS(method, params);
            if (response.error) {
                throw new Error(response.error.message);
            }
            return response.result;
        }
        return this.sendHTTP(method, params);
    }

    /**
     * Register a notification handler
     */
    onNotification(method, handler) {
        if (!this.notificationHandlers.has(method)) {
            this.notificationHandlers.set(method, []);
        }
        this.notificationHandlers.get(method).push(handler);
    }

    /**
     * Get the currently active player
     */
    async getActivePlayer() {
        const players = await this.send('Player.GetActivePlayers');
        return players?.[0] || null;
    }

    /**
     * Get player properties
     */
    async getPlayerProperties(playerId, properties = ['time', 'totaltime', 'speed', 'percentage']) {
        return this.send('Player.GetProperties', {
            playerid: playerId,
            properties
        });
    }

    /**
     * Get currently playing item info
     */
    async getPlayerItem(playerId) {
        return this.send('Player.GetItem', {
            playerid: playerId,
            properties: ['title', 'artist', 'album', 'year', 'thumbnail', 'file', 'showtitle', 'season', 'episode']
        });
    }

    /**
     * Get info labels (for detailed info)
     */
    async getInfoLabels(labels) {
        return this.send('XBMC.GetInfoLabels', { labels });
    }

    /**
     * Prepare a file for download (get HTTP URL)
     */
    async prepareDownload(path) {
        console.log('prepareDownload called with:', path);
        
        try {
            // Check if it's already an HTTP URL
            if (path.startsWith('http://') || path.startsWith('https://')) {
                console.log('Already HTTP URL, returning as-is');
                return path;
            }
            
            // Try Files.PrepareDownload first - this is the proper way
            try {
                const result = await this.send('Files.PrepareDownload', { path });
                const url = `http://${this.host}:${this.httpPort}/${result.details.path}`;
                console.log('Files.PrepareDownload succeeded:', url);
                return url;
            } catch (prepareError) {
                console.warn('Files.PrepareDownload failed:', prepareError);
            }
            
            // Fallback 1: Try VFS with just the path (no encoding of slashes)
            // Some Kodi versions want: /vfs/path/to/file.mp4
            const vfsUrl1 = `http://${this.host}:${this.httpPort}/vfs${path}`;
            console.log('Trying VFS URL (unencoded):', vfsUrl1);
            
            // Actually return the encoded version as that's more standard
            const vfsUrl2 = this.vfsUrl + encodeURIComponent(path);
            console.log('Using VFS URL (encoded):', vfsUrl2);
            return vfsUrl2;
            
        } catch (e) {
            console.error('prepareDownload error:', e);
            // Last resort fallback
            return this.vfsUrl + encodeURIComponent(path);
        }
    }

    /**
     * Player controls
     */
    async playPause(playerId) {
        return this.send('Player.PlayPause', { playerid: playerId });
    }

    async seek(playerId, percentage) {
        return this.send('Player.Seek', {
            playerid: playerId,
            value: percentage
        });
    }

    async seekTime(playerId, seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        
        return this.send('Player.Seek', {
            playerid: playerId,
            value: { time: { hours, minutes, seconds: secs, milliseconds: ms } }
        });
    }

    async setVolume(volume) {
        return this.send('Application.SetVolume', { volume: Math.round(volume) });
    }

    async getVolume() {
        return this.send('Application.GetProperties', {
            properties: ['volume', 'muted']
        });
    }

    async toggleMute() {
        return this.send('Application.SetMute', { mute: 'toggle' });
    }
}
