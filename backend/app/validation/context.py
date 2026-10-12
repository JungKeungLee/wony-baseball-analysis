"""SBO context hypotheses: an explicitly calibrated HUD template + visible motion.

The bundled header template is from the validation clip, not an independent
benchmark. No mound/object detector or physical speed inference is implied.
"""
from pathlib import Path
import json
import cv2
import numpy as np
from app.validation.quality import visible_joint


def pitching_header(frame):
    config=json.loads((Path(__file__).parent/'templates/sbo_pitching.json').read_text())
    h,w=frame.shape[:2];sx=w/1920;sy=h/1080;x,y,bw,bh=config['search_box']
    region=frame[round(y*sy):round((y+bh)*sy),round(x*sx):round((x+bw)*sx)]
    template=np.array([[int(v)*255 for v in row] for row in config['bitmap']],dtype=np.uint8)
    binary=(cv2.cvtColor(region,cv2.COLOR_BGR2GRAY)>config['threshold']).astype('uint8')*255
    best=0.0
    for scale in [.9,1,1.1]:
        ref=cv2.resize(template,(max(1,round(template.shape[1]*sx*scale)),max(1,round(template.shape[0]*sy*scale))),interpolation=cv2.INTER_NEAREST)
        if ref.shape[0]>binary.shape[0] or ref.shape[1]>binary.shape[1]:continue
        best=max(best,float(cv2.minMaxLoc(cv2.matchTemplate(binary,ref,cv2.TM_CCOEFF_NORMED))[1]))
    return {'type':'pitching_settings_template','confidence':round(best,3),'detected':best>=.85,
        'estimated':True,'accuracy_verified':False,'source':'single_clip_calibrated_hud_header_template'}


def throwing_sequence(samples,hand='right'):
    """Ordered raised-arm -> lowering sequence, using only visible right/left arm.

    This action cue alone also occurs outside pitching; it cannot set the role.
    Full-body gates for metrics remain unchanged. Leg lift is unavailable when
    the lifting knee is occluded, rather than filled or assumed.
    """
    shoulder,elbow,wrist=(12,14,16) if hand=='right' else (11,13,15)
    rows=[]
    for s in samples:
        if not all(visible_joint(s,i) for i in [11,12,23,24,shoulder,elbow,wrist]):continue
        p=s['landmarks'];aspect=s['aspect_ratio']
        torso=np.linalg.norm(np.mean([[p[i]['x']*aspect,p[i]['y']] for i in [11,12]],axis=0)-np.mean([[p[i]['x']*aspect,p[i]['y']] for i in [23,24]],axis=0))
        if torso<1e-5:continue
        rows.append((s['time_seconds'],(p[wrist]['y']-p[shoulder]['y'])/torso))
    evidence=None
    for i,(t,y) in enumerate(rows):
        window=[]
        for r in rows[i:]:
            if r[0]-t>2.5 or (window and r[0]-window[-1][0]>.25):break
            window.append(r)
        if len(window)<8 or window[-1][0]-t<.7:continue
        if max(np.diff([r[0] for r in window]),default=99)>.25:continue
        peak=min(range(len(window)),key=lambda j:window[j][1])
        if 0<peak<len(window)-1 and window[peak][1]<=-.2 and max(r[1] for r in window[peak+1:])>=.3:
            evidence={'start':window[0][0],'raised_arm_time':window[peak][0],'end':window[-1][0],
                'samples':len(window),'visibility_threshold':.6,'estimated':True,'confidence':.8}
            break
    return {'detected':evidence is not None,'confidence':.8 if evidence else 0,
        'method':'visible_arm_ordered_raise_lower_v1','evidence':evidence,'leg_lift':None,
        'leg_lift_reason':'No verified continuous lifting-leg evidence; not inferred from hidden joints'}


def pitcher_context(samples,header_observations,hud_votes):
    motion=throwing_sequence(samples)
    action=motion['evidence']
    detections=[o for o in header_observations if o['detected'] and action and
        action['start']-.4<=o['timestamp']<=action['end']+.4]
    # Repetition must be at distinct times over at least 0.4 seconds.
    repeated=len({o['timestamp'] for o in detections})>=3 and max((o['timestamp'] for o in detections),default=0)-min((o['timestamp'] for o in detections),default=0)>=.4
    header=min((o['confidence'] for o in detections),default=0) if repeated else 0
    speeds=[v for v in hud_votes if v['value'] is not None]
    changes=[]
    if action:
        for v in speeds:
            t=v.get('clip_time',v['timestamp'])
            prior=[p for p in speeds if p['metric']==v['metric'] and p.get('clip_time',p['timestamp'])<=action['end']]
            if action['end']<t<=action['end']+5 and prior and prior[-1]['value']!=v['value']:
                changes.append({'metric':v['metric'],'before':prior[-1]['value'],'after':v['value'],'timestamp':t})
    speed_after_motion=bool(changes)
    score=min(.8,.45*header+.45*motion['confidence']+(.1 if speed_after_motion else 0)) if repeated and motion['detected'] else 0
    return {'value':'pitcher' if score>=.7 else 'unknown','confidence':round(score,3),
        'estimated':True,'confidence_grade':'medium' if score>=.7 else 'low',
        'method':'sbo_header_repetition_visible_arm_sequence_v1','evidence_families':['scene','pose_motion'] if score else [],
        'pitching_settings':{'repeated':repeated,'samples':len(detections),'confidence':header,'source':'single_clip_calibrated_template'},
        'throwing_sequence':motion,'speed_hud_change_after_motion':speed_after_motion,
        'speed_hud_change_evidence':changes[:1],
        'mound_position':None,'accuracy_verified':False,
        'warning':'Uncalibrated context hypothesis; game HUD may describe another player. Motion must come from the manually locked WONY ROI.'}
