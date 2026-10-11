"""HTTP(S) stream adapter. No platform-specific API or credential handling."""
import ipaddress
import socket
import subprocess
from urllib.parse import urlsplit
from app.source.base import VideoSource, decode_image


def validate_url(value):
    url=urlsplit(value)
    if url.scheme not in {'http','https'} or not url.hostname or url.username or url.password:
        raise ValueError('Use a public HTTP(S) stream URL without embedded credentials')
    addresses=socket.getaddrinfo(url.hostname,url.port or (443 if url.scheme=='https' else 80),type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError('Stream host must resolve only to public addresses')
    return value


class StreamSource(VideoSource):
    def __init__(self,url):self.url=validate_url(url)
    def arguments(self,url):
        return ['-protocol_whitelist','http,tcp,crypto','-rw_timeout','15000000','-i',url]
    def sample(self,timestamp):
        from app.source.remote import Gateway
        with Gateway(self.url,finite=False) as gateway:return decode_image(self.arguments(gateway.url))
    def capture(self,destination,timestamp,duration):
        from app.source.remote import Gateway
        with Gateway(self.url,finite=False) as gateway:
            subprocess.run(['ffmpeg','-nostdin','-v','error','-y',*self.arguments(gateway.url),'-t',str(duration),'-an',
                '-vf','scale=320:320:force_original_aspect_ratio=decrease','-c:v','libx264','-threads','2',
                '-pix_fmt','yuv420p','-movflags','+faststart',str(destination)],
                capture_output=True,check=True,timeout=duration+30)
        return timestamp
