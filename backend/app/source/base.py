"""Provider-neutral acquisition only; adapters never evaluate players."""
from abc import ABC, abstractmethod
import subprocess
import cv2
import numpy as np


class VideoSource(ABC):
    @abstractmethod
    def sample(self, timestamp):
        """Return an image at source timeline time (seconds)."""

    @abstractmethod
    def capture(self, destination, timestamp, duration):
        """Acquire a bounded clip; return actual source-time offset."""


def decode_image(arguments):
    result=subprocess.run(['ffmpeg','-nostdin','-v','error',*arguments,
        '-frames:v','1','-vf','scale=320:320:force_original_aspect_ratio=decrease',
        '-f','image2pipe','-vcodec','mjpeg','pipe:1'],capture_output=True,check=True,timeout=25)
    frame=cv2.imdecode(np.frombuffer(result.stdout,dtype=np.uint8),cv2.IMREAD_COLOR)
    if frame is None:raise ValueError('No frame decoded')
    return frame
