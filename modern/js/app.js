/**
 * Shadow Player - Modern Edition
 * 
 * A browser-based video player that mirrors Kodi playback.
 */

import { KodiRPC } from './kodi-rpc.js';
import { SyncEngine } from './sync-engine.js';

class ShadowPlayer {
    constructor() {
        // DOM elements
        this.elements = {
            connectionScreen: document.getElementById('connection-screen'),
            playerScreen: document.getElementById('player-screen'),
            connectForm: document.getElementById('connect-form'),
            hostInput: document.getElementById('host-input'),
            portInput: document.getElementById('port-input'),
            connectBtn: document.getElementById('connect-btn'),
            errorMessage: document.getElementById('error-message'),
            video: document.getElementById('video'),
            videoContainer: document.getElementById('video-container'),
            title: document.getElementById('title'),
            subtitle: document.getElementById('subtitle'),
            idleMessage: document.getElementById('idle-message'),
            progress: document.getElementById('progress'),
            progressBar: document.getElementById('progress-bar'),
            currentTime: document.getElementById('current-time'),
            duration: document.getElementById('duration'),
            playPauseBtn: document.getElementById('play-pause-btn'),
            muteBtn: document.getElementById('mute-btn'),
            volumeSlider: document.getElementById('volume-slider'),
            statsBtn: document.getElementById('stats-btn'),
            stats: document.getElementById('stats'),
            statDelta: document.getElementById('stat-delta'),
            statLag: document.getElementById('stat-lag'),
            statSync: document.getElementById('stat-sync'),
            statusIndicator: document.getElementById('status-indicator'),
        };

        this.kodi = null;
        this.syncEngine = null;
        this.pollInterval = null;
        this.currentFile = null;
        this.isPlaying = false;
        
        this.init();
    }

    init() {
        // Try to restore last connection
        const lastHost = localStorage.getItem('shadowplayer_host');
        const lastPort = localStorage.getItem('shadowplayer_port');
        if (lastHost) {
            this.elements.hostInput.value = lastHost;
        }
        if (lastPort) {
            this.elements.portInput.value = lastPort;
        }

        // Event listeners
        this.elements.connectForm.addEventListener('submit', (e) => this.handleConnect(e));
        this.elements.playPauseBtn.addEventListener('click', () => this.togglePlayPause());
        this.elements.muteBtn.addEventListener('click', () => this.toggleMute());
        this.elements.volumeSlider.addEventListener('input', (e) => this.setVolume(e.target.value));
        this.elements.progressBar.addEventListener('click', (e) => this.seekFromProgressBar(e));
        this.elements.statsBtn.addEventListener('click', () => this.toggleStats());
        this.elements.videoContainer.addEventListener('dblclick', () => this.toggleStats());
        
        // Video element events
        this.elements.video.addEventListener('volumechange', () => this.updateVolumeUI());

        // Auto-hide controls
        let hideTimeout;
        this.elements.playerScreen.addEventListener('mousemove', () => {
            this.elements.playerScreen.classList.add('show-controls');
            clearTimeout(hideTimeout);
            hideTimeout = setTimeout(() => {
                this.elements.playerScreen.classList.remove('show-controls');
            }, 3000);
        });
    }

    async handleConnect(e) {
        e.preventDefault();
        
        const host = this.elements.hostInput.value.trim() || 'localhost';
        const port = parseInt(this.elements.portInput.value) || 8080;
        
        this.elements.connectBtn.disabled = true;
        this.elements.connectBtn.textContent = 'Connecting...';
        this.elements.errorMessage.textContent = '';

        try {
            this.kodi = new KodiRPC(host, port);
            
            this.kodi.onConnect = () => {
                this.elements.statusIndicator.classList.remove('disconnected');
            };
            
            this.kodi.onDisconnect = () => {
                this.elements.statusIndicator.classList.add('disconnected');
            };

            await this.kodi.connect();
            
            // Save successful connection
            localStorage.setItem('shadowplayer_host', host);
            localStorage.setItem('shadowplayer_port', port.toString());

            // Initialize sync engine
            this.syncEngine = new SyncEngine(this.elements.video);
            this.syncEngine.onStatsUpdate = (stats) => this.updateStats(stats);

            // Setup notification handlers
            this.setupNotifications();

            // Switch to player screen
            this.elements.connectionScreen.classList.add('hidden');
            this.elements.playerScreen.classList.remove('hidden');

            // Start polling
            this.startPolling();

        } catch (error) {
            this.elements.errorMessage.textContent = error.message;
            console.error('Connection failed:', error);
        } finally {
            this.elements.connectBtn.disabled = false;
            this.elements.connectBtn.textContent = 'Connect';
        }
    }

    setupNotifications() {
        // Listen for playback changes via WebSocket
        this.kodi.onNotification('Player.OnPlay', () => {
            console.log('Player.OnPlay notification');
            this.checkPlayback();
        });

        this.kodi.onNotification('Player.OnPause', () => {
            console.log('Player.OnPause notification');
            this.checkPlayback();
        });

        this.kodi.onNotification('Player.OnStop', () => {
            console.log('Player.OnStop notification');
            this.handleStop();
        });

        this.kodi.onNotification('Player.OnSeek', () => {
            console.log('Player.OnSeek notification');
            // Force immediate sync on seek
            this.syncEngine.temperature = 1;
        });
    }

    startPolling() {
        // Poll for player state
        const poll = async () => {
            try {
                await this.checkPlayback();
            } catch (e) {
                console.warn('Poll error:', e);
            }
        };

        poll();
        this.pollInterval = setInterval(poll, 250); // Poll 4 times per second
    }

    async checkPlayback() {
        const requestStart = performance.now() / 1000;
        
        try {
            const player = await this.kodi.getActivePlayer();
            
            if (!player) {
                this.handleStop();
                return;
            }

            // Get player properties
            const props = await this.kodi.getPlayerProperties(player.playerid, 
                ['time', 'totaltime', 'speed', 'percentage']);
            
            // Get current item info
            const itemInfo = await this.kodi.getPlayerItem(player.playerid);
            const item = itemInfo.item;

            // Check if we need to load a new file
            if (item.file && item.file !== this.currentFile) {
                await this.loadNewMedia(item);
            }

            // Update UI
            this.updateNowPlaying(item);
            this.updateTimeDisplay(props);
            
            // Update sync
            const remoteTime = this.syncEngine.timeToSeconds(props.time);
            this.syncEngine.update(remoteTime, props.speed, requestStart);
            
            this.isPlaying = props.speed !== 0;
            this.elements.idleMessage.classList.add('hidden');
            this.elements.statusIndicator.classList.toggle('syncing', !this.syncEngine.isSynced());

        } catch (e) {
            console.warn('Playback check error:', e);
        }
    }

    async loadNewMedia(item) {
        console.log('Loading new media:', item.file);
        this.currentFile = item.file;
        
        try {
            const url = await this.kodi.prepareDownload(item.file);
            console.log('Media URL:', url);
            
            this.elements.video.src = url;
            this.elements.video.load();
            
            // Mute by default to allow autoplay
            this.elements.video.muted = true;
            this.updateVolumeUI();
            
            this.syncEngine.reset();
        } catch (e) {
            console.error('Failed to load media:', e);
        }
    }

    handleStop() {
        this.isPlaying = false;
        this.currentFile = null;
        this.elements.video.pause();
        this.elements.video.src = '';
        this.elements.idleMessage.classList.remove('hidden');
        this.elements.title.textContent = '-';
        this.elements.subtitle.textContent = '';
        this.elements.progress.style.width = '0%';
        this.elements.currentTime.textContent = '0:00';
        this.elements.duration.textContent = '0:00';
        this.syncEngine?.reset();
    }

    updateNowPlaying(item) {
        let title = item.title || item.label || 'Unknown';
        let subtitle = '';

        if (item.showtitle) {
            // TV Show
            subtitle = item.showtitle;
            if (item.season && item.episode) {
                subtitle += ` - S${item.season}E${item.episode}`;
            }
        } else if (item.artist?.length) {
            // Music
            subtitle = item.artist.join(', ');
            if (item.album) {
                subtitle += ` - ${item.album}`;
            }
        } else if (item.year) {
            subtitle = item.year.toString();
        }

        this.elements.title.textContent = title;
        this.elements.subtitle.textContent = subtitle;
    }

    updateTimeDisplay(props) {
        const current = this.syncEngine.timeToSeconds(props.time);
        const total = this.syncEngine.timeToSeconds(props.totaltime);
        
        this.elements.currentTime.textContent = this.formatTime(current);
        this.elements.duration.textContent = this.formatTime(total);
        
        const percentage = total > 0 ? (current / total) * 100 : 0;
        this.elements.progress.style.width = `${percentage}%`;
    }

    updateStats(stats) {
        this.elements.statDelta.textContent = `${(stats.delta * 1000).toFixed(0)}ms`;
        this.elements.statLag.textContent = `${(stats.lag * 1000).toFixed(0)}ms`;
        this.elements.statSync.textContent = stats.playbackRate.toFixed(2) + 'x';
    }

    formatTime(seconds) {
        if (!isFinite(seconds)) return '0:00';
        
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        
        if (h > 0) {
            return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    async togglePlayPause() {
        const player = await this.kodi.getActivePlayer();
        if (player) {
            await this.kodi.playPause(player.playerid);
        }
    }

    toggleMute() {
        this.elements.video.muted = !this.elements.video.muted;
        this.updateVolumeUI();
    }

    setVolume(value) {
        this.elements.video.volume = value / 100;
        this.elements.video.muted = value === 0;
        this.updateVolumeUI();
    }

    updateVolumeUI() {
        const muted = this.elements.video.muted;
        const volume = this.elements.video.volume * 100;
        
        this.elements.muteBtn.textContent = muted || volume === 0 ? '🔇' : '🔊';
        this.elements.volumeSlider.value = muted ? 0 : volume;
    }

    async seekFromProgressBar(e) {
        const rect = this.elements.progressBar.getBoundingClientRect();
        const percentage = ((e.clientX - rect.left) / rect.width) * 100;
        
        const player = await this.kodi.getActivePlayer();
        if (player) {
            await this.kodi.seek(player.playerid, percentage);
            this.syncEngine.temperature = 1; // Force resync
        }
    }

    toggleStats() {
        this.elements.stats.classList.toggle('visible');
    }
}

// Start the app
new ShadowPlayer();
