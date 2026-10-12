"""Offline bat/effect validation artifacts, isolated from official player history."""
import hashlib,json,math,shutil
from pathlib import Path
from typing import Literal
from uuid import uuid4
import cv2
import numpy as np
from pydantic import BaseModel,Field,model_validator
from app.validation.runner import metadata
from app.validation.bat_tracking import SeededBatTracker,effect_candidates,swing_candidates
from app.validation.bat_hybrid import HybridBatTracker,expanded_search_bbox
from app.validation.bat_path import compare_paths,projected_type


class BatSeed(BaseModel):
    source_time:float=Field(ge=0)
    tip:tuple[float,float]
    shaft:tuple[float,float]
    width:float=Field(gt=0)
    @model_validator(mode='after')
    def finite(self):
        if not all(math.isfinite(v) for v in [self.source_time,self.width,*self.tip,*self.shaft]):raise ValueError('Finite seed required')
        return self


class BatConfig(BaseModel):
    effect_region:tuple[int,int,int,int]
    seeds:list[BatSeed]=Field(default_factory=list,max_length=10)
    tracker_mode:Literal['hybrid','legacy_lk']='hybrid'
    bat_search_margin:float=Field(default=.75,ge=.1,le=2)
    use_wrist_constraint:bool=False
    reviewed_object_track:bool=False
    calibrated_side_view:bool=False
    @model_validator(mode='after')
    def order(self):
        if any(a.source_time>=b.source_time for a,b in zip(self.seeds,self.seeds[1:])):raise ValueError('Manual seed epochs must be ordered')
        return self


def digest(path):
    value=hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda:source.read(1024*1024),b''):value.update(chunk)
    return value.hexdigest()


def wrist_hint(pose_samples,index,t,width,height):
    while index+1<len(pose_samples) and pose_samples[index+1]['time_seconds']<=t:index+=1
    if not pose_samples or abs(pose_samples[index]['time_seconds']-t)>.15:return None,index
    landmarks=pose_samples[index].get('landmarks',[]);points=[]
    for landmark_index in (15,16):
        if landmark_index>=len(landmarks):continue
        item=landmarks[landmark_index]
        if item.get('visibility',0)>=.6 and not item.get('outside_pose_crop',False):
            points.append([item['x']*width,item['y']*height])
    return (np.mean(points,axis=0).tolist() if points else None),index


def validate_bat_sequence(video,config:BatConfig,output_root,target_report=None):
    meta=metadata(video);sha=digest(video);target=None;tracking=[]
    if target_report:
        target=json.loads(Path(target_report).read_text(encoding='utf-8'))
        if digest(Path(target_report).parent/'source.mp4')!=sha:raise ValueError('Target lock report must match this exact video')
        selection=target['target_tracking']['selection']
        if not selection['confirmed_by_user'] or selection['viewpoint']!='third_person':raise ValueError('Confirmed third-person target required; no first-person body/bat attribution')
        tracking=target['target_tracking']['frames']
    if config.seeds and target is None:raise ValueError('Rendered bat seeds require a matching confirmed target lock report')
    if any(s.source_time>=meta['duration_seconds'] for s in config.seeds):raise ValueError('Seed exceeds source duration')
    # Validate source crop before decoding/writing artifacts.
    x,y,w,h=config.effect_region
    if min(x,y)<0 or min(w,h)<=0 or x+w>meta['width'] or y+h>meta['height']:raise ValueError('Effect region outside source')
    folder=Path(output_root)/str(uuid4());folder.mkdir(parents=True)
    cap=cv2.VideoCapture(str(video));cv2.setNumThreads(2)
    effects=[];epochs=[];current=None;tracker=None;next_seed=0;target_index=0;pose_index=0;previous_mask=None
    pose_samples=(target or {}).get('pose',[])
    stop_reason=None;end_time=None
    try:
        for i,(pts,t) in enumerate(meta['frame_pts']):
            ok,frame=cap.read()
            if not ok:break
            state=None
            if tracking:
                while target_index+1<len(tracking) and tracking[target_index+1]['source_time']<=t:target_index+=1
                state=tracking[target_index]
            fresh=bool(state and t>=state['source_time'] and t-state['source_time']<=.15)
            pose_allowed=bool(fresh and state['analysis_allowed'])
            allowed=bool(fresh and state['status'] in ('confirmed','tracking','low_confidence') and
                         not state.get('reidentification_required',False))
            if state and state['status'] in ('tracking_lost','reidentification_required'):
                if tracker is not None and current is not None:
                    current['frames'].append(dict(tracker.lose('WONY target lost; sequence analysis stopped'),timestamp=t,source_frame=i))
                stop_reason='target_tracking_lost';break
            end_time=t
            if next_seed<len(config.seeds) and t>=config.seeds[next_seed].source_time:
                seed=config.seeds[next_seed];next_seed+=1
                if current is not None:current['events']=swing_candidates(current['frames'])
                current={'seed':seed.model_dump(),'operator':'manual_visual_rendered_bat_annotation','frames':[],'events':[]};epochs.append(current)
                if allowed:
                    bx,by,bw,bh=state['bbox']
                    if not bx<=seed.shaft[0]<=bx+bw or not by<=seed.shaft[1]<=by+bh:raise ValueError('Manual shaft anchor must be within the WONY target lock')
                tracker=(HybridBatTracker(seed.tip,seed.shaft,seed.width)
                         if allowed and config.tracker_mode=='hybrid' else
                         SeededBatTracker(seed.tip,seed.shaft,seed.width) if allowed else None)
            record=None
            if current is not None:
                if tracker is not None:
                    if allowed and config.tracker_mode=='hybrid':
                        search=expanded_search_bbox(state['bbox'],frame.shape,config.bat_search_margin)
                        hand=None
                        if config.use_wrist_constraint and pose_samples and pose_allowed:
                            hand,pose_index=wrist_hint(pose_samples,pose_index,t,meta['width'],meta['height'])
                        record=tracker.update(frame,search_bbox=search,wrist_hint=hand)
                        record['search_bbox']=list(search)
                    else:
                        record=tracker.update(frame) if allowed else tracker.lose('WONY lock analysis unavailable; no wrist fallback')
                    if record['status'] in ('tracking','low_confidence'):
                        record['target_lock_status']=state['status']
                        record['target_lock_confidence']=state.get('confidence')
                        if state['status']=='low_confidence':
                            record['status']='low_confidence';record['confidence']=min(record['confidence'],.45)
                            record['confidence_grade']='low'
                            record['reason']='WONY target lock temporarily low confidence; bat remained seed-associated'
                        sx,sy=record['shaft_reference_xy']
                        if config.tracker_mode=='hybrid':
                            rx,ry,rw,rh=search
                            if not rx<=sx<=rx+rw or not ry<=sy<=ry+rh:
                                record=tracker.lose('Tracked handle left expanded WONY bat search ROI')
                        else:
                            bx,by,bw,bh=state['bbox']
                            if not bx-bw*.25<=sx<=bx+bw*1.25 or not by-bh*.1<=sy<=by+bh*1.1:
                                record=tracker.lose('Tracked shaft left selected target neighborhood')
                else:record={'status':'tracking_lost','reason':'No target attribution at seed','tip_xy':None,'shaft_reference_xy':None,'wrist_fallback_used':False,'bat_speed':None}
                record.update(timestamp=t,source_frame=i,original_pts=pts,time_base=meta['time_base'])
                current['frames'].append(record)
            if i%max(1,round(meta['fps']/10))==0:
                candidates,mask=effect_candidates(frame,config.effect_region)
                union=np.logical_or(mask,previous_mask).sum() if previous_mask is not None else 0
                iou=float(np.logical_and(mask,previous_mask).sum()/union) if union else None
                effects.append({'source_time':t,'source_frame':i,'candidates':candidates,'mask_overlap_previous':iou,
                    'semantics':'unknown','confirmed_bat_trail':False,'player_attribution':'unverified_global_effect'})
                previous_mask=mask
                preview=frame.copy()
                for item in candidates:
                    a,b,c,d=item['bbox'];cv2.rectangle(preview,(a,b),(a+c,b+d),(255,180,0),2)
                if record and record['status']=='tracking':
                    cv2.polylines(preview,[np.int32(record['polygon'])],True,(80,220,80),2)
                cv2.putText(preview,'EFFECT CANDIDATES != BAT PATH - ESTIMATED',(12,28),cv2.FONT_HERSHEY_SIMPLEX,.55,(255,255,255),1)
                if i%max(1,round(meta['fps']))==0:cv2.imwrite(str(folder/f'evidence-{i:05d}.jpg'),preview)
    finally:cap.release()
    if current is not None:current['events']=swing_candidates(current['frames'])
    tracked=sum(f['status']=='tracking' for e in epochs for f in e['frames'])
    events=[dict(e,epoch=n,source_sha256=sha) for n,epoch in enumerate(epochs) for e in epoch['events']]
    for event in events:
        event['verified_bat_path']=bool(config.reviewed_object_track and event.get('end') is not None and
            event.get('image_detection_coverage',0)>=.9 and event.get('minimum_tracking_confidence',0)>=.35)
        event['sequence_review']='operator_reviewed_visible_rendered_bat' if config.reviewed_object_track else 'not_reviewed'
    inputs={'contact':{'score':None,'observed_contact':None,'bat_path_candidate_refs':[{'epoch':e['epoch'],'start':e['start'],'end':e['end']} for e in events if e['end'] is not None],
        'reason':'Object movement is not bat/ball collision or contact ability'},
        'power':{'score':None,'lower_body_proxy':None,'mechanics_inputs':'rendered-object 2D motion candidates only' if events else None,
        'reason':'No validated force/velocity; full-body insufficient; wrist is not substituted for bat'}}
    result={'id':folder.name,'synthetic_demo':False,'validation_only':True,'player_id':target['player_id'] if target else None,
        'source_sha256':sha,'metadata':{k:v for k,v in meta.items() if k!='frame_pts'},'config':config.model_dump(),
        'target_report_id':target['id'] if target else None,'role_hint':(target or {}).get('role_input'),
        'analysis_stop_reason':stop_reason,'analysis_end_source_time':end_time,
        'automatic_role':(target or {}).get('automatic_role_estimate'),
        'effect_candidates':effects,'bat_object_epochs':epochs,'swing_candidates':events,
        'summary':{'effect_sample_count':len(effects),'effect_positive_samples':sum(bool(e['candidates']) for e in effects),
            'object_tracked_frames':tracked,'complete_swing_candidates':sum(e['end'] is not None for e in events),
            'incomplete_swing_candidates':sum(e['end'] is None for e in events)},
        'trail_confirmed':False,'bat_speed':None,'swing_type':None,
        'projected_swing_types':[projected_type(e,calibrated_side_view=config.calibrated_side_view) for e in events],
        'path_consistency':compare_paths(events),
        'path_consistency_reason':'Requires >=3 independently reviewed complete object paths and compatible camera/view; no wrist or effect-path fallback',
        'scouting_inputs':inputs,'estimated':True,'accuracy_verified':False,
        'warnings':['Manual object appearance seeds are not automatic bat detection. Detection/flow association may drift; actual paths require sequence review.',
            'Colored effects may be ball trajectories, HUD/debug vectors or bat effects. Detection is not semantic confirmation.',
            'No new role template/threshold relaxation, true bat speed, contact score, lower-body power or 3D reconstruction.']}
    (folder/'analysis.json').write_text(json.dumps(result,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    return result,folder
