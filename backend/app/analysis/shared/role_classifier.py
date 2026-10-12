"""Conservative temporal 2D role hypotheses, not calibrated probabilities."""
import numpy as np
from .pose_metrics import pose_rows

ROLES=('batter','defense','catcher','pitcher','baserunning')

def classify_role(samples, context=None):
    rows=pose_rows(samples);context=context or {};scores=dict.fromkeys(ROLES,0.0)
    result={'value':'unknown','estimated':True,'confidence':0.0,'confidence_grade':'low',
            'method':'temporal_pose_movement_context_v1','reason':'Insufficient or ambiguous temporal evidence'}
    sbo=context.get('sbo_pitcher',{})
    supported=(sbo.get('value')=='pitcher' and .7<=sbo.get('confidence',0)<=1
        and set(sbo.get('evidence_families',[]))>={'scene','pose_motion'})
    def sbo_result():
        return dict(result,value='pitcher',confidence=min(sbo['confidence'],.8),
            confidence_grade='medium',method=sbo['method'],reason=None,context_evidence=sbo,
            candidates=[{'role':r,'confidence':min(sbo['confidence'],.8) if r=='pitcher' else 0,'estimated':True} for r in ROLES])
    if len(rows)<5 or rows[-1]['t']-rows[0]['t']<.4:
        if supported:return sbo_result()
        return dict(result,candidates=[{'role':k,'confidence':v} for k,v in scores.items()])
    torso=np.median([r['torso'] for r in rows]);xy=np.array([r['xy'] for r in rows])
    knee=np.median([r['knee'] for r in rows]);hips=np.array([r['hips'] for r in rows])
    travel=float(np.linalg.norm(hips[-1]-hips[0])/torso)
    wrists=xy[:,[15,16]];hands=np.linalg.norm(wrists[:,0]-wrists[:,1],axis=1)/torso
    wrist_motion=float(np.max(np.ptp(wrists,axis=0))/torso)
    overhead=float(np.mean(wrists[:,:,1]<xy[:,[11,12],1]))
    ankle_delta=(xy[:,27,1]-xy[:,28,1])/torso
    crossings=int(np.sum(np.diff(np.sign(ankle_delta))!=0))
    leg_lift=float(np.max(np.abs(xy[:,25,1]-xy[:,26,1]))/torso)
    if np.median(hands)<.65 and wrist_motion>.8 and overhead<.6 and travel<1:
        scores['batter']=.76+(.08 if context.get('bat_detected',0)>=.7 else 0)
    if overhead>.2 and wrist_motion>1 and leg_lift>.55 and travel<1.4:
        scores['pitcher']=.78
    if knee>65 and travel<.35 and .12<wrist_motion<1 and overhead<.15:
        scores['catcher']=.77+(.06 if context.get('glove_detected',0)>=.7 else 0)
    if travel>.8 and crossings>=2 and knee<65 and overhead<.2:
        scores['baserunning']=.79
    if knee>25 and travel>.35 and np.median(hands)>.65 and overhead<.2 and crossings<2:
        scores['defense']=.74+(.07 if context.get('glove_detected',0)>=.7 else 0)
    ordered=sorted(scores.items(),key=lambda kv:kv[1],reverse=True)
    visibility=min(r['visibility'] for r in rows)
    confidence=min(ordered[0][1],visibility*.9)
    if confidence>=.7 and ordered[0][1]-ordered[1][1]>=.15:
        result.update(value=ordered[0][0],confidence=round(confidence,3),confidence_grade='high' if confidence>=.75 else 'medium',reason=None)
    result['candidates']=[{'role':k,'confidence':round(v,3),'estimated':True} for k,v in ordered]
    if supported:
        if ordered[0][1]>=.7 and ordered[0][0]!='pitcher':
            result.update(value='unknown',confidence=0.0,confidence_grade='low',reason='SBO context conflicts with generic temporal role evidence')
        else:return sbo_result()
    return result
