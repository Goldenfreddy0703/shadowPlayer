# -*- coding: utf-8 -*-
"""
Shadow Player RTSP Bridge Service
Converts RTSP streams to HLS for browser playback

This service:
1. Runs a small HTTP API server on port 8089
2. Accepts RTSP URL via POST /start
3. Runs FFmpeg to transcode RTSP → HLS
4. Serves HLS files on port 8089/hls/
"""

import xbmc
import xbmcaddon
import xbmcvfs
import subprocess
import os
import threading
import json
import socket
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

ADDON = xbmcaddon.Addon()
ADDON_ID = ADDON.getAddonInfo('id')
ADDON_PATH = xbmcvfs.translatePath(ADDON.getAddonInfo('path'))
ADDON_DATA = xbmcvfs.translatePath(ADDON.getAddonInfo('profile'))

# Configuration
API_PORT = 8089
HLS_SEGMENT_TIME = 2  # seconds per segment
HLS_LIST_SIZE = 5     # number of segments to keep

# Create directories
if not os.path.exists(ADDON_DATA):
    os.makedirs(ADDON_DATA)

HLS_OUTPUT_DIR = os.path.join(ADDON_DATA, 'hls')
if not os.path.exists(HLS_OUTPUT_DIR):
    os.makedirs(HLS_OUTPUT_DIR)


def log(message, level=xbmc.LOGINFO):
    xbmc.log(f'{ADDON_ID}: {message}', level)


def get_local_ip():
    """Get the local IP address"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"


class FFmpegTranscoder:
    """Handles RTSP to HLS transcoding via FFmpeg"""
    
    def __init__(self):
        self.process = None
        self.rtsp_url = None
        self.running = False
        self.error = None
        self.start_time = None
        
    def clean_hls_dir(self):
        """Remove old HLS files"""
        try:
            for f in os.listdir(HLS_OUTPUT_DIR):
                filepath = os.path.join(HLS_OUTPUT_DIR, f)
                try:
                    os.remove(filepath)
                except:
                    pass
        except Exception as e:
            log(f'Error cleaning HLS dir: {e}', xbmc.LOGWARNING)
    
    def find_ffmpeg(self):
        """Find FFmpeg binary"""
        # Common locations
        locations = [
            'ffmpeg',  # In PATH
            '/usr/bin/ffmpeg',
            '/usr/local/bin/ffmpeg',
            '/opt/bin/ffmpeg',
            '/system/bin/ffmpeg',  # Android
            '/data/data/org.xbmc.kodi/files/ffmpeg',  # Kodi Android
        ]
        
        for loc in locations:
            try:
                result = subprocess.run([loc, '-version'], 
                                       capture_output=True, 
                                       timeout=5)
                if result.returncode == 0:
                    log(f'Found FFmpeg at: {loc}')
                    return loc
            except:
                continue
        
        return None
    
    def start(self, rtsp_url):
        """Start transcoding RTSP to HLS"""
        if self.running:
            self.stop()
        
        self.rtsp_url = rtsp_url
        self.error = None
        self.clean_hls_dir()
        
        ffmpeg_path = self.find_ffmpeg()
        if not ffmpeg_path:
            self.error = "FFmpeg not found. Please install FFmpeg."
            log(self.error, xbmc.LOGERROR)
            return False
        
        output_path = os.path.join(HLS_OUTPUT_DIR, 'stream.m3u8')
        segment_path = os.path.join(HLS_OUTPUT_DIR, 'segment_%03d.ts')
        
        # FFmpeg command for RTSP to HLS
        cmd = [
            ffmpeg_path,
            '-y',  # Overwrite output
            '-fflags', 'nobuffer',  # Reduce buffering
            '-rtsp_transport', 'tcp',  # Use TCP for RTSP (more reliable)
            '-i', rtsp_url,  # Input RTSP stream
            # Video encoding
            '-c:v', 'libx264',  # H.264 codec (browser compatible)
            '-preset', 'ultrafast',  # Fast encoding
            '-tune', 'zerolatency',  # Low latency
            '-profile:v', 'baseline',  # Most compatible H.264 profile
            '-level', '3.0',
            '-pix_fmt', 'yuv420p',  # Standard pixel format
            '-g', '30',  # Keyframe every 30 frames
            '-sc_threshold', '0',  # Disable scene change detection
            # Video scaling (optional, for performance)
            '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease',
            '-b:v', '2500k',  # Video bitrate
            '-maxrate', '2500k',
            '-bufsize', '5000k',
            # Audio encoding
            '-c:a', 'aac',  # AAC audio (browser compatible)
            '-b:a', '128k',
            '-ar', '44100',  # Sample rate
            '-ac', '2',  # Stereo
            # HLS output
            '-f', 'hls',
            '-hls_time', str(HLS_SEGMENT_TIME),
            '-hls_list_size', str(HLS_LIST_SIZE),
            '-hls_flags', 'delete_segments+append_list+omit_endlist',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', segment_path,
            output_path
        ]
        
        log(f'Starting FFmpeg: {" ".join(cmd)}')
        
        try:
            # Start FFmpeg process
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.PIPE
            )
            self.running = True
            self.start_time = time.time()
            
            # Start a thread to monitor FFmpeg output
            self.monitor_thread = threading.Thread(target=self._monitor_ffmpeg)
            self.monitor_thread.daemon = True
            self.monitor_thread.start()
            
            log(f'FFmpeg started with PID: {self.process.pid}')
            return True
            
        except Exception as e:
            self.error = f'Failed to start FFmpeg: {str(e)}'
            log(self.error, xbmc.LOGERROR)
            self.running = False
            return False
    
    def _monitor_ffmpeg(self):
        """Monitor FFmpeg stderr for errors"""
        try:
            for line in self.process.stderr:
                line = line.decode('utf-8', errors='ignore').strip()
                if line:
                    # Log FFmpeg output at debug level
                    log(f'FFmpeg: {line}', xbmc.LOGDEBUG)
                    # Check for errors
                    if 'error' in line.lower():
                        self.error = line
        except:
            pass
    
    def stop(self):
        """Stop transcoding"""
        self.running = False
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=5)
            except:
                try:
                    self.process.kill()
                except:
                    pass
            self.process = None
        log('FFmpeg stopped')
    
    def is_running(self):
        """Check if transcoding is active"""
        if self.process:
            poll = self.process.poll()
            if poll is not None:
                self.running = False
                if poll != 0:
                    self.error = f'FFmpeg exited with code {poll}'
            return self.running
        return False
    
    def get_status(self):
        """Get current status"""
        running = self.is_running()
        status = {
            'running': running,
            'rtsp_url': self.rtsp_url if running else None,
            'error': self.error,
            'uptime': int(time.time() - self.start_time) if running and self.start_time else 0
        }
        return status


# Global transcoder instance
transcoder = FFmpegTranscoder()


class APIHandler(BaseHTTPRequestHandler):
    """HTTP API handler for controlling the transcoder"""
    
    def log_message(self, format, *args):
        log(f'API: {format % args}', xbmc.LOGDEBUG)
    
    def send_json(self, data, status=200):
        """Send JSON response"""
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))
    
    def send_file(self, filepath, content_type):
        """Send a file"""
        try:
            with open(filepath, 'rb') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', len(content))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            self.wfile.write(content)
        except FileNotFoundError:
            self.send_json({'error': 'File not found'}, 404)
        except Exception as e:
            self.send_json({'error': str(e)}, 500)
    
    def do_OPTIONS(self):
        """Handle CORS preflight"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
    
    def do_GET(self):
        """Handle GET requests"""
        path = urlparse(self.path).path
        
        if path == '/status':
            # Get transcoder status
            status = transcoder.get_status()
            status['hls_url'] = f'http://{get_local_ip()}:{API_PORT}/hls/stream.m3u8'
            self.send_json(status)
            
        elif path.startswith('/hls/'):
            # Serve HLS files
            filename = path[5:]  # Remove '/hls/'
            if filename in ['stream.m3u8'] or filename.startswith('segment_'):
                filepath = os.path.join(HLS_OUTPUT_DIR, filename)
                if filename.endswith('.m3u8'):
                    self.send_file(filepath, 'application/vnd.apple.mpegurl')
                elif filename.endswith('.ts'):
                    self.send_file(filepath, 'video/mp2t')
                else:
                    self.send_json({'error': 'Invalid file type'}, 400)
            else:
                self.send_json({'error': 'Invalid file'}, 400)
                
        elif path == '/':
            # API info
            self.send_json({
                'service': 'Shadow Player RTSP Bridge',
                'version': '1.0.0',
                'endpoints': {
                    'POST /start': 'Start transcoding (body: {"rtsp_url": "rtsp://..."})',
                    'POST /stop': 'Stop transcoding',
                    'GET /status': 'Get current status',
                    'GET /hls/stream.m3u8': 'HLS playlist (when running)'
                },
                'local_ip': get_local_ip(),
                'port': API_PORT
            })
        else:
            self.send_json({'error': 'Not found'}, 404)
    
    def do_POST(self):
        """Handle POST requests"""
        path = urlparse(self.path).path
        
        if path == '/start':
            # Start transcoding
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8')
                data = json.loads(body) if body else {}
                
                rtsp_url = data.get('rtsp_url', '').strip()
                if not rtsp_url:
                    self.send_json({'error': 'rtsp_url is required'}, 400)
                    return
                
                if not rtsp_url.startswith('rtsp://'):
                    self.send_json({'error': 'Invalid RTSP URL'}, 400)
                    return
                
                success = transcoder.start(rtsp_url)
                if success:
                    # Wait a moment for FFmpeg to start
                    time.sleep(1)
                    self.send_json({
                        'success': True,
                        'message': 'Transcoding started',
                        'hls_url': f'http://{get_local_ip()}:{API_PORT}/hls/stream.m3u8'
                    })
                else:
                    self.send_json({
                        'success': False,
                        'error': transcoder.error or 'Failed to start transcoding'
                    }, 500)
                    
            except json.JSONDecodeError:
                self.send_json({'error': 'Invalid JSON'}, 400)
            except Exception as e:
                self.send_json({'error': str(e)}, 500)
                
        elif path == '/stop':
            # Stop transcoding
            transcoder.stop()
            self.send_json({'success': True, 'message': 'Transcoding stopped'})
            
        else:
            self.send_json({'error': 'Not found'}, 404)


class ThreadedHTTPServer(HTTPServer):
    """HTTP server that handles requests in threads"""
    allow_reuse_address = True
    
    def process_request(self, request, client_address):
        thread = threading.Thread(target=self.process_request_thread,
                                 args=(request, client_address))
        thread.daemon = True
        thread.start()
    
    def process_request_thread(self, request, client_address):
        try:
            self.finish_request(request, client_address)
        except:
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(request)


def main():
    """Main service entry point"""
    log('Shadow Player RTSP Bridge starting...')
    
    monitor = xbmc.Monitor()
    local_ip = get_local_ip()
    
    # Start API server
    try:
        server = ThreadedHTTPServer(('0.0.0.0', API_PORT), APIHandler)
        server_thread = threading.Thread(target=server.serve_forever)
        server_thread.daemon = True
        server_thread.start()
        log(f'API server started on http://{local_ip}:{API_PORT}')
    except Exception as e:
        log(f'Failed to start API server: {e}', xbmc.LOGERROR)
        return
    
    # Main loop
    while not monitor.abortRequested():
        if monitor.waitForAbort(1):
            break
    
    # Cleanup
    log('Shutting down...')
    transcoder.stop()
    server.shutdown()
    log('Shadow Player RTSP Bridge stopped')


if __name__ == '__main__':
    main()
