# -*- coding: utf-8 -*-
"""
Shadow Player RTSP Service
Converts RTSP streams to HLS for browser playback
"""

import xbmc
import xbmcaddon
import xbmcgui
import xbmcvfs
import subprocess
import os
import threading
import json
from http.server import HTTPServer, SimpleHTTPRequestHandler
import socket

ADDON = xbmcaddon.Addon()
ADDON_ID = ADDON.getAddonInfo('id')
ADDON_PATH = xbmcvfs.translatePath(ADDON.getAddonInfo('path'))
ADDON_DATA = xbmcvfs.translatePath(ADDON.getAddonInfo('profile'))

# Create data directory if it doesn't exist
if not os.path.exists(ADDON_DATA):
    os.makedirs(ADDON_DATA)

HLS_OUTPUT_DIR = os.path.join(ADDON_DATA, 'hls')
if not os.path.exists(HLS_OUTPUT_DIR):
    os.makedirs(HLS_OUTPUT_DIR)


class RTSPtoHLSConverter:
    """Converts RTSP stream to HLS using FFmpeg"""
    
    def __init__(self):
        self.process = None
        self.running = False
        self.rtsp_url = None
        
    def start(self, rtsp_url):
        """Start converting RTSP to HLS"""
        if self.running:
            self.stop()
            
        self.rtsp_url = rtsp_url
        self.running = True
        
        # Clean old HLS files
        self._clean_hls_dir()
        
        # FFmpeg command to convert RTSP to HLS
        output_path = os.path.join(HLS_OUTPUT_DIR, 'stream.m3u8')
        
        cmd = [
            'ffmpeg',
            '-rtsp_transport', 'tcp',  # Use TCP for more reliable streaming
            '-i', rtsp_url,
            '-c:v', 'libx264',  # Transcode to H.264 for browser compatibility
            '-preset', 'ultrafast',  # Fast encoding for low latency
            '-tune', 'zerolatency',  # Optimize for low latency
            '-c:a', 'aac',  # Audio codec
            '-f', 'hls',  # Output format
            '-hls_time', '2',  # Segment duration (seconds)
            '-hls_list_size', '3',  # Number of segments to keep
            '-hls_flags', 'delete_segments+append_list',  # Clean up old segments
            '-hls_segment_filename', os.path.join(HLS_OUTPUT_DIR, 'segment_%03d.ts'),
            output_path
        ]
        
        xbmc.log(f'{ADDON_ID}: Starting FFmpeg with command: {" ".join(cmd)}', xbmc.LOGINFO)
        
        try:
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.PIPE
            )
            xbmc.log(f'{ADDON_ID}: FFmpeg started successfully', xbmc.LOGINFO)
            return True
        except Exception as e:
            xbmc.log(f'{ADDON_ID}: Failed to start FFmpeg: {e}', xbmc.LOGERROR)
            self.running = False
            return False
    
    def stop(self):
        """Stop the conversion"""
        self.running = False
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=5)
            except:
                self.process.kill()
            self.process = None
        xbmc.log(f'{ADDON_ID}: FFmpeg stopped', xbmc.LOGINFO)
    
    def is_running(self):
        """Check if conversion is running"""
        if self.process:
            return self.process.poll() is None
        return False
    
    def _clean_hls_dir(self):
        """Remove old HLS files"""
        for f in os.listdir(HLS_OUTPUT_DIR):
            try:
                os.remove(os.path.join(HLS_OUTPUT_DIR, f))
            except:
                pass


class HLSHandler(SimpleHTTPRequestHandler):
    """HTTP handler that serves HLS files with CORS headers"""
    
    def __init__(self, *args, directory=None, **kwargs):
        self.directory = directory or HLS_OUTPUT_DIR
        super().__init__(*args, **kwargs)
    
    def translate_path(self, path):
        """Translate URL path to filesystem path"""
        # Remove leading slash and 'hls' prefix if present
        path = path.lstrip('/')
        if path.startswith('hls/'):
            path = path[4:]
        return os.path.join(HLS_OUTPUT_DIR, path)
    
    def end_headers(self):
        """Add CORS headers"""
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
    
    def do_OPTIONS(self):
        """Handle CORS preflight"""
        self.send_response(200)
        self.end_headers()
    
    def log_message(self, format, *args):
        """Log to Kodi log"""
        xbmc.log(f'{ADDON_ID} HLS Server: {format % args}', xbmc.LOGDEBUG)


class HLSServer:
    """Simple HTTP server for HLS segments"""
    
    def __init__(self, port=8088):
        self.port = port
        self.server = None
        self.thread = None
        
    def start(self):
        """Start the HLS server"""
        try:
            handler = lambda *args, **kwargs: HLSHandler(*args, directory=HLS_OUTPUT_DIR, **kwargs)
            self.server = HTTPServer(('0.0.0.0', self.port), handler)
            self.thread = threading.Thread(target=self.server.serve_forever)
            self.thread.daemon = True
            self.thread.start()
            xbmc.log(f'{ADDON_ID}: HLS server started on port {self.port}', xbmc.LOGINFO)
            return True
        except Exception as e:
            xbmc.log(f'{ADDON_ID}: Failed to start HLS server: {e}', xbmc.LOGERROR)
            return False
    
    def stop(self):
        """Stop the server"""
        if self.server:
            self.server.shutdown()
            self.server = None
        xbmc.log(f'{ADDON_ID}: HLS server stopped', xbmc.LOGINFO)


class ShadowPlayerService:
    """Main service class"""
    
    def __init__(self):
        self.converter = RTSPtoHLSConverter()
        self.hls_server = HLSServer()
        self.monitor = xbmc.Monitor()
        
    def get_local_ip(self):
        """Get local IP address"""
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except:
            return "127.0.0.1"
    
    def run(self):
        """Main service loop"""
        xbmc.log(f'{ADDON_ID}: Service starting...', xbmc.LOGINFO)
        
        # Start HLS server
        self.hls_server.start()
        
        local_ip = self.get_local_ip()
        xbmc.log(f'{ADDON_ID}: HLS stream will be available at http://{local_ip}:8088/stream.m3u8', xbmc.LOGINFO)
        
        # Main loop - wait for abort
        while not self.monitor.abortRequested():
            if self.monitor.waitForAbort(1):
                break
        
        # Cleanup
        self.converter.stop()
        self.hls_server.stop()
        xbmc.log(f'{ADDON_ID}: Service stopped', xbmc.LOGINFO)


if __name__ == '__main__':
    service = ShadowPlayerService()
    service.run()
