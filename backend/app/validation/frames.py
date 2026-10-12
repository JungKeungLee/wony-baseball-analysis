"""Disk-backed preview frames keep longer validation clips memory bounded."""
import cv2


class PreviewFrames:
    def __init__(self,folder):self.folder=folder;self.items=[];folder.mkdir()
    def append(self,item):
        timestamp,image=item;path=self.folder/f'{len(self.items):05d}.jpg'
        if not cv2.imwrite(str(path),image):raise ValueError('Cannot store preview frame')
        self.items.append((timestamp,path))
    def __len__(self):return len(self.items)
    def __iter__(self):
        for t,path in self.items:
            image=cv2.imread(str(path))
            if image is None:raise ValueError('Missing preview frame')
            yield t,image
    def __getitem__(self,index):
        t,path=self.items[index];return t,cv2.imread(str(path))
