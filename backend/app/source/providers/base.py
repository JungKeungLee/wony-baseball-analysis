"""Platform pages require an explicit adapter; never treat HTML as video."""
from abc import ABC, abstractmethod

class ProviderAdapter(ABC):
    @abstractmethod
    def supports(self, url): ...
    @abstractmethod
    def resolve(self, url):
        """Return a public direct MP4/HLS URL, without downloading full media."""

ADAPTERS = []
