"""Reviewed rendered-bat image paths only; no wrist/effect substitution."""
import numpy as np

OBJECT_SOURCE='manual_rendered_bat_seed_lk_ransac_appearance_v1'
HYBRID_OBJECT_SOURCE='manual_bat_seed_detection_flow_association_v2'


def path_points(event):
    if (event.get('source') not in (OBJECT_SOURCE,HYBRID_OBJECT_SOURCE) or not event.get('verified_bat_path') or
        event.get('status')!='complete_candidate' or event.get('end') is None):return None
    try:
        path=event['path'];t=np.array([p['timestamp'] for p in path],dtype=float)
        xy=np.array([p.get('path_point_xy',p.get('tip_xy')) for p in path],dtype=float)
        if len(t)<6 or xy.shape!=(len(t),2) or not np.isfinite(t).all() or not np.isfinite(xy).all():return None
        if np.any(np.diff(t)<=0) or max(np.diff(t))>.05 or t[-1]-t[0]<.1:return None
        return t,xy
    except (ValueError,KeyError,TypeError):return None


def projected_type(event,*,calibrated_side_view=False):
    points=path_points(event)
    if not calibrated_side_view or points is None:return None
    _,xy=points;delta=xy[-1]-xy[0];steps=np.diff(xy[:,0])
    if abs(delta[0])<20 or np.mean(steps*np.sign(delta[0])>=0)<.8:return None
    slope=-float(delta[1])/abs(float(delta[0]))
    return {'value':'uppercut' if slope>.3 else 'downswing' if slope<-.3 else 'level',
        'estimated':True,'confidence':.25,'confidence_grade':'low',
        'method':'Reviewed bat-tip monotonic image-plane direction in declared calibrated side view; not physical 3D swing plane'}


def compare_paths(events,*,camera_context=None,reference_length=None):
    if not camera_context or reference_length is None or not np.isfinite(reference_length) or reference_length<=0:return None
    eligible={}
    for event in events:
        points=path_points(event)
        if points is None:continue
        key=(event.get('source_sha256'),event.get('epoch'),event['start'],event['end'])
        if key in eligible:continue
        t,xy=points;normalized=(t-t[0])/(t[-1]-t[0]);grid=np.linspace(0,1,20)
        aligned=np.array([np.interp(grid,normalized,xy[:,axis]-xy[0,axis]) for axis in range(2)]).T/reference_length
        eligible[key]=aligned
    if len(eligible)<3:return None
    paths=np.array(list(eligible.values()));center=np.median(paths,axis=0)
    return {'value':float(np.sqrt(np.mean(np.sum((paths-center)**2,axis=2)))),
        'unit':'manual_seed_reference_lengths','sample_count':len(paths),'camera_context':camera_context,
        'estimated':True,'confidence':.25,'confidence_grade':'low','ability_score':None,
        'method':'Reviewed object-tip paths, elapsed-time normalized RMS image deviation; camera/perspective/3D accuracy unvalidated'}
