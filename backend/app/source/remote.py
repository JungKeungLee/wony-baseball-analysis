"""Seekable URL source with a validating HTTP gateway for redirects/HLS references.

Gateway forwards byte ranges, not a full-file download. Every upstream request is
validated. Connections pin a public IP and preserve TLS certificate validation/SNI.
Deployment egress controls remain recommended defense in depth. DRM is unsupported.
"""
import re
import ipaddress
import socket
import os
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urljoin, urlsplit
import httpx
from app.source.stream import validate_url
from app.source.file import FileSource


def resolve_source(url):
    from app.source.providers.base import ADAPTERS
    for _ in range(4):
        validate_url(url)
        path=urlsplit(url).path.lower()
        if path.endswith('.mp4'): return url,'mp4'
        if path.endswith('.m3u8'): return url,'hls'
        for adapter in ADAPTERS:
            if adapter.supports(url):url=adapter.resolve(url);break
        else:raise ValueError('Platform page/unsupported URL: supply a direct .mp4 or VOD .m3u8 URL; provider adapter required')
    raise ValueError('Provider resolution loop')


def source_kind(url):return resolve_source(url)[1]


def pinned_request(client,url,headers):
    """Pin each validated connection to a public IP, preserving Host/TLS SNI."""
    validate_url(url);parts=urlsplit(url)
    addresses=socket.getaddrinfo(parts.hostname,parts.port or (443 if parts.scheme=='https' else 80),type=socket.SOCK_STREAM)
    ips=[address[4][0] for address in addresses]
    if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):raise ValueError('Non-public destination')
    request=client.build_request('GET',httpx.URL(url).copy_with(host=ips[0]),
        headers={**headers,'Host':parts.netloc,'Accept-Encoding':'identity'})
    request.extensions['sni_hostname']=parts.hostname
    return request


class Gateway:
    """finite=False permits rolling playlists for the shared LIVE adapter."""
    def __init__(self, url,finite=True):
        self.urls={};self.reverse={};self.next=0;self.lock=threading.Lock()
        gateway=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                upstream=gateway.urls.get(self.path)
                if not upstream: self.send_error(404);return
                try:
                    with httpx.Client(timeout=20,trust_env=False) as client:
                        headers={'Range':self.headers['Range']} if self.headers.get('Range') else {}
                        for _ in range(6):
                            validate_url(upstream)
                            response=client.send(pinned_request(client,upstream,headers),stream=True)
                            if response.status_code in (301,302,303,307,308):
                                location=response.headers.get('location');response.close()
                                if not location:raise ValueError('Invalid redirect')
                                upstream=urljoin(upstream,location);continue
                            break
                        else: raise ValueError('Too many redirects')
                        try:
                            response.raise_for_status()
                            if headers.get('Range','bytes=0-').split('=')[-1].split('-')[0] not in ('','0') and response.status_code!=206:
                                raise ValueError('Direct MP4 host must support byte range seeking')
                            kind=response.headers.get('content-type','')
                            if urlsplit(upstream).path.lower().endswith('.m3u8') or 'mpegurl' in kind:
                                chunks=[];size=0
                                for chunk in response.iter_bytes():
                                    size+=len(chunk)
                                    if size>2*1024*1024:raise ValueError('Manifest too large')
                                    chunks.append(chunk)
                                text=b''.join(chunks).decode('utf-8')
                                if '#EXTM3U' not in text:raise ValueError('Invalid HLS')
                                if finite and '#EXT-X-ENDLIST' not in text and '#EXT-X-STREAM-INF' not in text:
                                    raise ValueError('VOD requires a finite HLS playlist')
                                lines=[]
                                for line in text.splitlines():
                                    if line and not line.startswith('#'):line=gateway.register(urljoin(upstream,line))
                                    elif 'URI="' in line:
                                        line=re.sub(r'URI="([^"]+)"',lambda m:'URI="'+gateway.register(urljoin(upstream,m[1]))+'"',line)
                                    lines.append(line)
                                payload=('\n'.join(lines)+'\n').encode()
                                self.send_response(200);self.send_header('Content-Type','application/vnd.apple.mpegurl');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
                            else:
                                if 'text/html' in kind:raise ValueError('HTML is not media')
                                self.send_response(response.status_code)
                                for name in ('Content-Type','Content-Length','Content-Range','Accept-Ranges'):
                                    if name.lower() in response.headers:self.send_header(name,response.headers[name])
                                self.end_headers()
                                transferred=0
                                budget=int(os.getenv('WONY_REMOTE_REQUEST_MAX_BYTES',str(128*1024**2)))
                                for chunk in response.iter_bytes():
                                    transferred+=len(chunk)
                                    if transferred>budget:raise ValueError('Remote request byte budget exceeded')
                                    self.wfile.write(chunk)
                        finally:response.close()
                except (BrokenPipeError,ConnectionResetError):pass
                except Exception:self.send_error(502,'Upstream media rejected or unavailable')
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.server.daemon_threads=True
        self.url=self.register(url)
    def register(self,url):
        validate_url(url)
        with self.lock:
            if url in self.reverse:return self.reverse[url]
            if len(self.urls)>=100000:raise ValueError('Too many HLS references')
            self.next+=1;suffix=urlsplit(url).path.rsplit('/',1)[-1].rsplit('.',1)[-1]
            suffix=suffix if suffix in {'mp4','m3u8','ts','m4s','aac','key'} else 'bin'
            key=f'/media/{self.next}.{suffix}';self.urls[key]=url
            address=f'http://127.0.0.1:{self.server.server_port}{key}'
            self.reverse[url]=address
            return address
    def __enter__(self):
        threading.Thread(target=self.server.serve_forever,daemon=True).start();return self
    def __exit__(self,*args):self.server.shutdown();self.server.server_close()


@contextmanager
def open_remote(url):
    url,kind=resolve_source(url)
    with Gateway(url) as gateway:
        from app.source.direct_video import DirectVideoSource
        from app.source.hls import HlsSource
        yield (DirectVideoSource if kind=='mp4' else HlsSource)(gateway.url)
