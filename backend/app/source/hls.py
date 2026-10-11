"""Finite HLS seeking through rewritten, validated playlists."""
from app.source.file import FileSource

class HlsSource(FileSource):
    input_kind = 'hls'
