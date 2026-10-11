from pathlib import Path
import subprocess
from app.source.base import VideoSource, decode_image


class FileSource(VideoSource):
    def __init__(self,path):self.path=str(path) if str(path).startswith(('http://','https://')) else Path(path)
    def sample(self,timestamp):return decode_image(['-ss',str(timestamp),'-protocol_whitelist','file,http,tcp,crypto','-i',str(self.path)])
    def capture(self,destination,timestamp,duration):
        subprocess.run(['ffmpeg','-nostdin','-v','error','-y','-ss',str(timestamp),'-protocol_whitelist','file,http,tcp,crypto','-i',str(self.path),
            '-t',str(duration),'-an','-vf','scale=320:320:force_original_aspect_ratio=decrease',
            '-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-movflags','+faststart',str(destination)],capture_output=True,check=True,timeout=90)
        return timestamp
