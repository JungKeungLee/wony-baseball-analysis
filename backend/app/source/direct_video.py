"""MP4 seeking through the validating remote gateway."""
from app.source.file import FileSource

class DirectVideoSource(FileSource):
    input_kind = 'mp4'
