"""Explicit synthetic fixtures for UI demonstration; not pose-estimation validation."""
import math
import cv2
import numpy as np
from .joints import JOINTS, EDGES


def synthetic_clip(role):
    frames, samples = [], []
    for n in range(36):
        progress = n/35
        action = (1-math.cos(progress*math.pi))/2
        swing = math.sin(action*math.pi)
        points = [dict(x=.5, y=.5, z=0.0, visibility=.94) for _ in range(33)]
        positions = {
            0: (.49, .19, 0), 11: (.43, .31, -.03), 12: (.57, .31, .03),
            13: (.37, .42, -.08), 14: (.63, .42, .08),
            15: (.40, .48, -.12), 16: (.60, .48, .12),
            23: (.45, .58, -.02), 24: (.55, .58, .02),
            25: (.39, .73, 0), 26: (.62, .73, 0),
            27: (.33, .88, 0), 28: (.68, .88, 0),
        }
        if role == 'batter':
            for i in [0, 11, 12, 23, 24]:
                x,y,z = positions[i]
                positions[i]=(x+.06*progress,y+.025*swing,z)
            positions[13]=(.40+.10*progress,.32+.06*swing,-.10)
            positions[14]=(.61+.08*progress,.34+.03*swing,.05)
            positions[15]=(.39+.35*action,.27+.22*swing,-.25*swing)
            positions[16]=(.43+.35*action,.29+.22*swing,-.25*swing)
            positions[27]=(.33+.12*progress,.88-.12*math.sin(min(progress*2,1)*math.pi),0)
        elif role == 'pitcher':
            positions[14]=(.61+.07*swing,.32-.12*swing,.08)
            positions[16]=(.60+.23*action,.22+.35*action,-.3*swing)
            positions[25]=(.39,.73-.2*swing,0)
            positions[27]=(.33-.06*progress,.88-.25*swing,0)
        else:
            shift = .30*action if role == 'baserunning' else .12*swing if role == 'defense' else .025*swing
            for i,(x,y,z) in list(positions.items()):
                positions[i]=(x+shift, y+(.08*swing if i<25 else 0),z)
            positions[15]=(.36+shift+.1*progress,.58+.10*swing,-.2*swing)
            positions[16]=(.60+shift,.5+.08*swing,-.05)
            if role == 'catcher':
                positions[15]=(.36+shift+.15*action,.58+.18*swing,-.2*swing)
        for i, (x,y,z) in positions.items():
            points[i].update(x=x,y=y,z=z)
        frame=np.full((360,480,3),(37,31,24),dtype=np.uint8)
        cv2.rectangle(frame,(0,245),(480,360),(49,52,35),-1)
        for y in [260,295,345]:
            cv2.line(frame,(0,y),(480,y),(70,76,52),1)
        for x in range(-240,800,120):
            cv2.line(frame,(240,225),(x,360),(70,76,52),1)
        cv2.ellipse(frame,(245,321),(100,12),0,0,360,(25,28,19),-1)
        coords={name:(int(points[i]['x']*480),int(points[i]['y']*360)) for name,i in JOINTS.items()}
        torso=np.array([coords[k] for k in ['left_shoulder','right_shoulder','right_hip','left_hip']])
        cv2.fillConvexPoly(frame,torso,(140,129,65))
        for a,b in EDGES:
            if a!='head':
                cv2.line(frame,coords[a],coords[b],(137,150,146),14,cv2.LINE_AA)
        cv2.circle(frame,coords['head'],17,(153,174,176),-1,cv2.LINE_AA)
        cv2.putText(frame,'SYNTHETIC DEMO - NOT REAL VIDEO',(12,350),cv2.FONT_HERSHEY_SIMPLEX,.4,(182,202,190),1)
        frames.append((n/10,frame))
        samples.append(dict(time_seconds=n/10,aspect_ratio=480/360,estimated=True,
                            source='synthetic_demo',landmarks=points))
    return frames,samples
