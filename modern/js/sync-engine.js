/**
 * Playback Synchronization Engine
 * 
 * Keeps a local HTML5 video in sync with Kodi's playback.
 * Uses adaptive playback rate adjustment for smooth synchronization.
 * 
 * Based on the original shadowPlayer algorithm by Samuel Bailey.
 */

export class SyncEngine {
    constructor(videoElement) {
        this.video = videoElement;
        
        // Sync parameters
        this.maxPlaybackRate = 4;      // Maximum speed multiplier
        this.minPlaybackRate = 0.25;   // Minimum speed multiplier
        this.syncThreshold = 0.1;      // Seconds - below this we're "in sync"
        this.jumpThreshold = 2;        // Seconds - above this we jump instead of smooth sync
        
        // State tracking
        this.lastRemoteTime = 0;
        this.lastLocalTime = 0;
        this.lastLag = 0;
        this.temperature = 1;          // Smoothing factor
        this.remoteSpeed = 0;
        
        // Stats for debugging
        this.stats = {
            delta: 0,
            lag: 0,
            jitter: 0,
            playbackRate: 1
        };
        
        // Callbacks
        this.onStatsUpdate = null;
    }

    /**
     * Convert Kodi time object to seconds
     */
    timeToSeconds(time) {
        if (!time) return 0;
        return (time.hours || 0) * 3600 + 
               (time.minutes || 0) * 60 + 
               (time.seconds || 0) + 
               (time.milliseconds || 0) / 1000;
    }

    /**
     * Update sync state based on remote player state
     */
    update(remoteTime, remoteSpeed, requestStartTime) {
        const localTime = this.video.currentTime;
        
        // Calculate network lag (round-trip / 2)
        const now = performance.now() / 1000;
        const lag = (now - requestStartTime) / 2;
        
        // Compensate remote time for network lag
        const compensatedRemoteTime = remoteTime + lag + (remoteSpeed * lag);
        
        // Calculate time difference
        const delta = compensatedRemoteTime - localTime;
        
        // Calculate jitter (change in lag)
        const jitter = this.lastLag > 0 ? Math.abs(lag - this.lastLag) / this.lastLag : 0;
        
        // Update stats
        this.stats.delta = delta;
        this.stats.lag = lag;
        this.stats.jitter = jitter;
        
        // Handle different playback states
        if (remoteSpeed === 0) {
            // Remote is paused
            this.video.pause();
            this.stats.playbackRate = 0;
        } else if (!isFinite(localTime) || isNaN(localTime)) {
            // Video not ready
            this.stats.playbackRate = 0;
        } else if (jitter > 0.5) {
            // High jitter - network unstable, don't adjust
            this.video.playbackRate = remoteSpeed;
            this.stats.playbackRate = remoteSpeed;
        } else if (Math.abs(delta) > this.jumpThreshold) {
            // Too far out of sync - jump to correct position
            console.log(`Jumping to ${compensatedRemoteTime.toFixed(2)}s (delta: ${delta.toFixed(2)}s)`);
            this.video.currentTime = compensatedRemoteTime;
            this.video.playbackRate = remoteSpeed;
            this.temperature = 1;
            this.stats.playbackRate = remoteSpeed;
            
            if (this.video.paused && remoteSpeed > 0) {
                this.video.play().catch(() => {});
            }
        } else if (Math.abs(delta) < this.syncThreshold) {
            // Close enough - maintain normal speed
            this.video.playbackRate = remoteSpeed;
            this.temperature *= 0.95;
            this.stats.playbackRate = remoteSpeed;
            
            if (this.video.paused && remoteSpeed > 0) {
                this.video.play().catch(() => {});
            }
        } else {
            // Smooth sync using adaptive playback rate
            // The formula adjusts speed based on how far behind/ahead we are
            const timeStep = 0.25;
            let playbackRate = (2 * timeStep) / ((-delta * this.temperature) + (2 * timeStep)) * remoteSpeed;
            
            // Clamp to valid range
            playbackRate = Math.max(this.minPlaybackRate, Math.min(this.maxPlaybackRate, playbackRate));
            
            if (isFinite(playbackRate)) {
                this.video.playbackRate = playbackRate;
                this.temperature *= 0.95;
                this.stats.playbackRate = playbackRate;
            }
            
            if (this.video.paused && remoteSpeed > 0) {
                this.video.play().catch(() => {});
            }
        }
        
        // Update tracking state
        this.lastRemoteTime = compensatedRemoteTime;
        this.lastLocalTime = localTime;
        this.lastLag = (this.lastLag * 0.7) + (lag * 0.3); // Smoothed lag
        this.remoteSpeed = remoteSpeed;
        
        // Notify stats update
        if (this.onStatsUpdate) {
            this.onStatsUpdate(this.stats);
        }
    }

    /**
     * Set a new video source
     */
    async setSource(url) {
        return new Promise((resolve, reject) => {
            this.video.src = url;
            
            const onCanPlay = () => {
                this.video.removeEventListener('canplay', onCanPlay);
                this.video.removeEventListener('error', onError);
                this.reset();
                resolve();
            };
            
            const onError = (e) => {
                this.video.removeEventListener('canplay', onCanPlay);
                this.video.removeEventListener('error', onError);
                reject(new Error('Failed to load video'));
            };
            
            this.video.addEventListener('canplay', onCanPlay);
            this.video.addEventListener('error', onError);
            
            this.video.load();
        });
    }

    /**
     * Reset sync state
     */
    reset() {
        this.lastRemoteTime = 0;
        this.lastLocalTime = 0;
        this.lastLag = 0;
        this.temperature = 1;
        this.remoteSpeed = 0;
        this.video.playbackRate = 1;
    }

    /**
     * Check if currently synced
     */
    isSynced() {
        return Math.abs(this.stats.delta) < this.syncThreshold;
    }
}
