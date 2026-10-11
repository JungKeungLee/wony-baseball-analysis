"""Sparse, bounded evidence scan. No pose/scouting runs here."""
import math
import os
import subprocess
import json
import cv2
import numpy as np
from app.video.frames import InvalidVideo

ROLES = {'batter', 'defense', 'catcher', 'pitcher', 'baserunning', 'unknown'}


def seconds(value):
    if isinstance(value, bool):
        raise ValueError('Boolean is not a timestamp')
    if isinstance(value, str) and ':' in value:
        parts = value.split(':')
        if len(parts) != 3 or any(float(p) < 0 for p in parts) or any(float(p) >= 60 for p in parts[1:]):
            raise ValueError('Use HH:MM:SS timestamps')
        value = float(parts[0])*3600 + float(parts[1])*60 + float(parts[2])
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise ValueError('Timestamp must be finite and nonnegative')
    return number


def probe(path):
    try:
        r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', str(path)], capture_output=True, check=True, timeout=30)
        metadata = json.loads(r.stdout)
        duration = float(metadata['format']['duration'])
        if not math.isfinite(duration) or not 0 < duration <= 86400 or not any(s['codec_type'] == 'video' for s in metadata['streams']):
            raise ValueError()
        return duration
    except (subprocess.SubprocessError, OSError, KeyError, ValueError) as exc:
        raise InvalidVideo('A decodable video of at most 24 hours is required') from exc


class SignalDetector:
    """Optional local YOLOv8 COCO ONNX (raw 1x84x8400 output); no downloads.

    Class 34 bat, 35 glove, 32 sports ball. Sports balls alone are not baseball evidence.
    Field color is contextual only; temporal posture/motion uses sparse pose.
    Optional WONY_SCENE_ONNX is a 3-class YOLO export: field, baseball UI, scoreboard.
    """
    def __init__(self,enable_pose=True):
        model = os.getenv('WONY_SEGMENT_ONNX')
        self.net = cv2.dnn.readNetFromONNX(model) if model else None
        scene=os.getenv('WONY_SCENE_ONNX')
        self.scene=cv2.dnn.readNetFromONNX(scene) if scene else None
        self.history=[];self.tick=0;self.pose=None;self.enable_pose=enable_pose

    def close(self):
        if self.pose is not None:self.pose.close()

    def __call__(self, frame):
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        green = float(np.mean(cv2.inRange(hsv, (30, 40, 30), (95, 255, 255)) > 0))
        signals = {'field_color_candidate': min(.6, green) if green > .25 else 0.0}
        if self.net is not None:
            # Letterbox preprocessing for the documented YOLOv8 COCO export.
            h, w = frame.shape[:2]; scale = 640/max(h, w)
            resized = cv2.resize(frame, (round(w*scale), round(h*scale)))
            canvas = np.full((640,640,3),114,dtype=np.uint8)
            y=(640-resized.shape[0])//2;x=(640-resized.shape[1])//2
            canvas[y:y+resized.shape[0],x:x+resized.shape[1]]=resized
            self.net.setInput(cv2.dnn.blobFromImage(canvas, 1/255, (640,640), swapRB=True))
            output = self.net.forward()
            if output.ndim != 3 or output.shape[0] != 1 or output.shape[1] != 84:
                raise ValueError('Expected YOLOv8 COCO ONNX raw output [1,84,N]')
            scores = output[0,4:]
            for name, index in [('bat_detected',34),('glove_detected',35),('sports_ball_candidate',32)]:
                signals[name] = float(np.clip(scores[index].max(),0,1))
        if self.scene is not None:
            h,w=frame.shape[:2];scale=640/max(h,w)
            resized=cv2.resize(frame,(round(w*scale),round(h*scale)))
            canvas=np.full((640,640,3),114,dtype=np.uint8)
            y=(640-resized.shape[0])//2;x=(640-resized.shape[1])//2
            canvas[y:y+resized.shape[0],x:x+resized.shape[1]]=resized
            self.scene.setInput(cv2.dnn.blobFromImage(canvas,1/255,(640,640),swapRB=True))
            output=self.scene.forward()
            if output.ndim!=3 or output.shape[:2]!=(1,7):raise ValueError('Expected scene YOLO output [1,7,N]')
            for index,name in enumerate(['field_detected','baseball_ui','scoreboard_detected']):
                signals[name]=float(np.clip(output[0,4+index].max(),0,1))
        # Only contextual candidates get a sparse, small-image pose pass.
        # No full-frame extraction, scouting, or detailed analysis in WATCHING.
        if self.enable_pose and (green>.25 or max(signals.get('bat_detected',0),signals.get('glove_detected',0),signals.get('field_detected',0),signals.get('baseball_ui',0))>=.6):
            if self.pose is None:
                import mediapipe as mp
                self.pose=mp.solutions.pose.Pose(static_image_mode=True,model_complexity=1)
            h,w=frame.shape[:2];image=cv2.resize(frame,(256,max(1,round(h*256/w))))
            observation=self.pose.process(cv2.cvtColor(image,cv2.COLOR_BGR2RGB))
            self.tick+=1
            if observation.pose_landmarks:
                self.history.append({'time_seconds':self.tick*5.,'aspect_ratio':w/h,
                    'landmarks':[{'x':p.x,'y':p.y,'z':p.z,'visibility':p.visibility} for p in observation.pose_landmarks.landmark]})
                self.history=self.history[-6:]
                from app.analysis.shared.role_classifier import classify_role
                role=classify_role(self.history,signals)
                if role['value']!='unknown':signals[role['value']+'_motion']=role['confidence']
            else:self.history=[]
        else:self.history=[]
        return signals


def scene_context(frames):
    """At most three context frames, reused by every automatic-role entrypoint."""
    context={}
    if not frames:return context
    detector=SignalDetector(enable_pose=False)
    try:
        for index in np.linspace(0,len(frames)-1,min(3,len(frames)),dtype=int):
            for name,value in detector(frames[index][1]).items():context[name]=max(context.get(name,0),value)
    finally:detector.close()
    return context


def evidence(signals, threshold=.8):
    bat=signals.get('bat_detected',0);glove=signals.get('glove_detected',0)
    field=max(signals.get('field_detected',0),signals.get('field_color_candidate',0))
    motion=max([signals.get(role+'_motion',0) for role in ROLES if role!='unknown']+
               [signals.get('baseball_motion',0)])
    ui=max(signals.get('baseball_ui',0),signals.get('scoreboard_detected',0))
    # Independent groups: baseball equipment, temporal activity, scene context.
    object_score=max(bat,glove)
    legacy=bat>=.8 and glove>=.8 and field>=.25
    temporal=motion>=.7 and object_score>=.8 and (field>=.25 or ui>=.8)
    scene_motion=signals.get('field_detected',0)>=.8 and ui>=.8 and motion>=.7
    strong=legacy or temporal or scene_motion
    confidence=max(min(bat,glove) if legacy else 0,
        min(object_score,.8+.2*max(0,motion-.7)/.3) if temporal else 0,
        min(signals.get('field_detected',0),ui) if scene_motion else 0)
    if not strong:confidence=min(.49,max(object_score,field,motion,ui))
    return confidence,strong and confidence>=threshold


def merge_samples(samples, duration, interval, gap=20, buffer=10, threshold=.8):
    groups=[]
    for sample in samples:
        conf, accepted=evidence(sample['signals'], threshold)
        if conf == 0:
            continue
        item={'core_start':max(0,sample['timestamp']-interval/2), 'core_end':min(duration,sample['timestamp']+interval/2),
              'confidence':conf,'review_required':not accepted,'signals':set(k for k,v in sample['signals'].items() if v>0),
              'sample_count':1}
        if groups and item['review_required']==groups[-1]['review_required'] and item['core_start']-groups[-1]['core_end'] <= gap:
            prev=groups[-1];prev['core_end']=item['core_end'];prev['confidence']=min(prev['confidence'],conf)
            prev['signals'].update(item['signals']);prev['sample_count']+=1
        else:
            groups.append(item)
    for i,g in enumerate(groups):
        g.update(id=f'segment-{i+1}',start=max(0,g['core_start']-buffer),end=min(duration,g['core_end']+buffer),
                 estimated=True,role='unknown',role_confidence=0.0,source='automatic',
                 boundary_resolution_seconds=interval, role_segments=[])
        g['duration']=g['end']-g['start'];g['signals']=sorted(g['signals'])
    return groups


def scan(path, duration, config, progress, detector=None):
    detector = detector or SignalDetector()
    from app.source.file import FileSource
    source=FileSource(path)
    search_start=config.get('search_start',0);search_end=config.get('search_end',duration)
    span=search_end-search_start
    interval=max(config['sample_interval'],span/(config['max_scan_frames']-1))
    count=min(config['max_scan_frames'],math.ceil(span/interval))
    samples=[]; failures=0
    for index in range(count):
        timestamp=search_start+index*interval
        try:
            frame=source.sample(timestamp)
            samples.append({'timestamp':timestamp,'signals':detector(frame)})
        except (subprocess.SubprocessError, ValueError, cv2.error):
            failures+=1
        progress(index+1,count)
    if hasattr(detector,'close'):detector.close()
    if not samples:
        raise InvalidVideo('No scan frames could be decoded')
    groups=merge_samples(samples,duration,interval,config['merge_gap'],config['buffer'],config['threshold'])
    for group in groups:
        group['core_start']=max(search_start,group['core_start']);group['core_end']=min(search_end,group['core_end'])
        group['start']=max(search_start,group['start']);group['end']=min(search_end,group['end']);group['duration']=group['end']-group['start']
    return groups, {'search_start':search_start,'search_end':search_end,'sampled_frames':len(samples),'failed_samples':failures,'effective_interval':interval,
        'detector':'objects_context_temporal_pose' if os.getenv('WONY_SEGMENT_ONNX') or os.getenv('WONY_SCENE_ONNX') else 'context_temporal_pose_review_only',
        'warning':'Heuristic confidence is not calibrated. Sparse contextual pose sampling is bounded; color or posture alone never confirms baseball. Equipment/scene model evidence is required.'}


def manual_segments(items, duration):
    if not isinstance(items,list) or not 1 <= len(items) <= 200:
        raise ValueError('Provide 1..200 segments')
    result=[]
    for i,item in enumerate(items):
        start,end=seconds(item['start']),seconds(item['end']);role=item.get('role','unknown')
        if role=='auto':role='unknown'
        if not 0 <= start < end <= duration or role not in ROLES:
            raise ValueError('Invalid bounds or role')
        result.append({'id':f'manual-{i+1}','start':start,'end':end,'duration':end-start,'core_start':start,'core_end':end,
            'confidence':None,'estimated':True,'review_required':False,'signals':['user_confirmed_baseball'],
            'source':'manual','role':role,'role_confidence':None,'role_segments':[]})
    result.sort(key=lambda s:s['start'])
    if any(a['end']>b['start'] for a,b in zip(result,result[1:])):
        raise ValueError('Manual segments must not overlap; split by role if needed')
    return result
