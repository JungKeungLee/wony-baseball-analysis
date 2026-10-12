"""Explicitly seeded rendered-object optical flow, separate from wrist/colored FX.

Experimental image tracking; seed semantics need visual review. No replacement
search, no wrist fallback, no physical velocity or true swing-plane inference.
"""
import cv2
import numpy as np


def transform_points(points,matrix):
    return np.asarray(points,dtype=np.float32)@matrix[:,:2].T+matrix[:,2]


class SeededBatTracker:
    def __init__(self,tip,shaft,width):
        self.axis=np.asarray([tip,shaft],dtype=np.float32)
        delta=self.axis[1]-self.axis[0];self.length=float(np.linalg.norm(delta))
        if self.length<20 or not 2<=width<=self.length*.3:raise ValueError('Nondegenerate manual rendered-bat axis/width required')
        normal=np.array([-delta[1],delta[0]])/self.length
        self.polygon=np.array([self.axis[0]+normal*width/2,self.axis[1]+normal*width/4,
            self.axis[1]-normal*width/4,self.axis[0]-normal*width/2],dtype=np.float32)
        self.previous=None;self.points=None;self.histogram=None;self.status='uninitialized';self.reason=None

    def histogram_at(self,frame):
        mask=np.zeros(frame.shape[:2],dtype=np.uint8);cv2.fillConvexPoly(mask,np.int32(self.polygon),255)
        hsv=cv2.cvtColor(frame,cv2.COLOR_BGR2HSV)
        return cv2.normalize(cv2.calcHist([hsv],[0,1],mask,[16,16],[0,180,0,256]),None)

    def lose(self,reason):
        self.status='tracking_lost';self.reason=reason
        return self.record()

    def record(self,quality=0):
        return {'status':self.status,'reason':self.reason,'estimated':True,
            'confidence':round(min(.6,quality),3),'confidence_grade':'low',
            'tip_xy':self.axis[0].tolist() if self.status=='tracking' else None,
            'shaft_reference_xy':self.axis[1].tolist() if self.status=='tracking' else None,
            'polygon':self.polygon.tolist() if self.status=='tracking' else None,
            'source':'manual_rendered_bat_seed_lk_ransac_appearance_v1',
            'coordinate_space':'source_pixels','automatic_reidentification':False,
            'wrist_fallback_used':False,'bat_speed':None,'accuracy_verified':False}

    def update(self,frame):
        if self.status=='tracking_lost':return self.record()
        gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
        if self.previous is None:
            if np.any(self.polygon<0) or np.any(self.polygon[:,0]>=frame.shape[1]) or np.any(self.polygon[:,1]>=frame.shape[0]):return self.lose('Seed polygon outside source')
            mask=np.zeros(frame.shape[:2],dtype=np.uint8);cv2.fillConvexPoly(mask,np.int32(self.polygon),255)
            self.points=cv2.goodFeaturesToTrack(gray,80,.01,5,mask=mask,blockSize=3)
            if self.points is None or len(self.points)<8:return self.lose('Insufficient independent texture features in manually labeled bat')
            self.histogram=self.histogram_at(frame);self.previous=gray;self.status='tracking'
            return self.record(.6)
        current,ok,_=cv2.calcOpticalFlowPyrLK(self.previous,gray,self.points,None,winSize=(31,31),maxLevel=3)
        if current is None:return self.lose('Optical flow failed')
        back,back_ok,_=cv2.calcOpticalFlowPyrLK(gray,self.previous,current,None,winSize=(31,31),maxLevel=3)
        if back is None:return self.lose('Reverse optical flow failed')
        error=np.linalg.norm(self.points.reshape(-1,2)-back.reshape(-1,2),axis=1)
        valid=ok.ravel().astype(bool)&back_ok.ravel().astype(bool)&(error<=1.5)&np.isfinite(current.reshape(-1,2)).all(axis=1)
        if valid.sum()<8 or valid.mean()<.7:return self.lose('Texture support / forward-backward consistency insufficient')
        old=self.points.reshape(-1,2)[valid];new=current.reshape(-1,2)[valid]
        matrix,inliers=cv2.estimateAffinePartial2D(old,new,method=cv2.RANSAC,ransacReprojThreshold=2)
        if matrix is None or not np.isfinite(matrix).all() or inliers.sum()<8 or inliers.mean()<.75:return self.lose('Rigid object fit insufficient')
        scale=float(np.linalg.norm(matrix[:,0]));residual=np.linalg.norm(transform_points(old,matrix)-new,axis=1)
        if not .85<=scale<=1.15 or float(np.median(residual))>2:return self.lose('Abrupt scale / nonrigid motion')
        polygon=transform_points(self.polygon,matrix);axis=transform_points(self.axis,matrix)
        if np.any(polygon<0) or np.any(polygon[:,0]>=frame.shape[1]) or np.any(polygon[:,1]>=frame.shape[0]):return self.lose('Object left visible source')
        self.polygon=polygon;self.axis=axis
        distance=float(cv2.compareHist(self.histogram,self.histogram_at(frame),cv2.HISTCMP_BHATTACHARYYA))
        if distance>.4:return self.lose('Seed appearance no longer supported; no target replacement')
        self.points=new[inliers.ravel().astype(bool)].reshape(-1,1,2);self.previous=gray;self.status='tracking'
        return self.record(.6*float(inliers.mean())*(1-distance))


def effect_candidates(frame,region):
    """High-saturation non-field-green components are candidates, never bat trail."""
    x,y,w,h=map(int,region)
    if min(x,y)<0 or min(w,h)<=0 or x+w>frame.shape[1] or y+h>frame.shape[0]:raise ValueError('Effect search region outside source')
    image=frame[y:y+h,x:x+w];hsv=cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
    hue,saturation,value=cv2.split(hsv)
    mask=((saturation>=150)&(value>=130)&~((hue>=35)&(hue<=85))).astype(np.uint8)*255
    components,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE);candidates=[]
    minimum=max(8,w*h*.00003)
    for contour in components:
        area=cv2.contourArea(contour)
        if area<minimum:continue
        rect=cv2.minAreaRect(contour);long,short=sorted(rect[1],reverse=True)
        if long<max(w,h)*.025 or long/max(short,1)<2:continue
        bx,by,bw,bh=cv2.boundingRect(contour)
        candidates.append({'bbox':[x+bx,y+by,bw,bh],'pixel_area':float(area),
            'estimated':True,'confidence':.25,'semantic_type':'unknown_colored_effect',
            'confirmed_bat_trail':False,'reason':'Color/elongation candidate only; may be ball path, HUD/vector, particle or bat effect'})
    return candidates,mask


def swing_candidates(records):
    """Image motion hysteresis only; incomplete tracks never receive an end."""
    events=[];active=None;hot=[];cold=[];path=[]
    for previous,current in zip(records,records[1:]):
        accepted=('tracking','low_confidence')
        if previous['status'] not in accepted or current['status'] not in accepted:
            if active is not None:events.append({'start':active,'end':None,'status':'incomplete_tracking_lost','path':path})
            active=None;hot=[];cold=[];path=[];continue
        dt=current['timestamp']-previous['timestamp']
        if not 0<dt<=.05:
            if active is not None:events.append({'start':active,'end':None,'status':'incomplete_sampling_gap','path':path})
            active=None;hot=[];cold=[];path=[];continue
        a=np.array(previous['tip_xy'])-np.array(previous['shaft_reference_xy']);b=np.array(current['tip_xy'])-np.array(current['shaft_reference_xy'])
        turn=abs(float(np.degrees(np.arctan2(a[0]*b[1]-a[1]*b[0],np.dot(a,b)))))/dt
        tip_motion=float(np.linalg.norm(np.array(current['tip_xy'])-previous['tip_xy']))/max(np.linalg.norm(a),1)/dt
        high=turn>=180 and tip_motion>=1.5;low=turn<=45 and tip_motion<=.3
        if active is None:
            hot=hot+[current] if high else []
            if len(hot)>=3:
                active=hot[0]['timestamp'];path=[_path_observation(r) for r in hot];cold=[]
        else:
            path.append(_path_observation(current))
            cold=cold+[current['timestamp']] if low else []
            if cold and current['timestamp']-cold[0]>=.15:
                events.append({'start':active,'end':cold[0],'status':'complete_candidate','path':[r for r in path if r['timestamp']<=cold[0]]});active=None;hot=[];cold=[];path=[]
    if active is not None:events.append({'start':active,'end':None,'status':'incomplete_clip_end','path':path})
    for event in events:
        confidences=[p.get('confidence',0) for p in event['path']]
        detections=[p.get('image_detection_supported') for p in event['path'] if 'image_detection_supported' in p]
        event.update(type='swing_candidate',estimated=True,confidence=.25,confidence_grade='low',
            source=next((p.get('source') for p in event['path'] if p.get('source')),'manual_rendered_bat_seed_lk_ransac_appearance_v1'),
            image_detection_coverage=(sum(bool(v) for v in detections)/len(detections) if detections else None),
            minimum_tracking_confidence=min(confidences) if confidences else 0,verified_bat_path=False,
            verified_swing=False,swing_type=None,swing_type_reason='Uncalibrated camera/swing plane; image direction is not physical downswing/level/uppercut',contact=None,bat_speed=None)
    return events


def _path_observation(record):
    return {key:record.get(key) for key in ('timestamp','tip_xy','handle_xy','shaft_reference_xy',
        'path_point_xy','orientation_degrees_image','confidence','status','tracking_method',
        'detection_source','image_detection_supported','wrist_constraint_used','source') if key in record}
