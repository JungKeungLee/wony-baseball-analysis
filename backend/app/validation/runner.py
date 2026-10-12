"""Bounded validation harness reusing existing pose, roles, scouting and visualization.

This does not feed unvalidated observations into player history. Whole-video
discovery, automatic identity and first-person body reconstruction are absent.
"""
import json
from itertools import chain
import shutil
import subprocess
from pathlib import Path
from uuid import uuid4
from datetime import datetime, timezone
from fractions import Fraction
from zoneinfo import ZoneInfo
import cv2
from app.validation.target import ManualTargetTracker, TargetSelection, crop, map_pose_to_source, expanded_roi, pose_in_target
from app.pose.extractor import extract_pose
from app.analysis.engine import analyze_role
from app.analysis.shared.pose_metrics import pose_rows
from app.visualization.builder import build_visualization
from app.scouting.report import build_report
from app.validation.quality import quality_report, restrict_3d, gate_pitcher_phases
from app.validation.context import pitching_header, pitcher_context
from app.validation.hud import digit_observation, temporal_vote, game_speed_summary
from app.validation.frames import PreviewFrames


def metadata(path):
    result=subprocess.run(['ffprobe','-v','error','-select_streams','v:0',
        '-show_entries','format=duration,size:stream=width,height,codec_name,avg_frame_rate,time_base,start_time',
        '-of','json',str(path)],capture_output=True,check=True,timeout=30)
    data=json.loads(result.stdout);stream=data['streams'][0]
    duration=float(data['format']['duration'])
    if not 0<duration<=120:raise ValueError('Validation accepts a local video of at most 120 seconds')
    timestamps=subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-show_frames',
        '-show_entries','frame=best_effort_timestamp,best_effort_timestamp_time','-of','json',str(path)],
        capture_output=True,check=True,timeout=30)
    frame_data=json.loads(timestamps.stdout)['frames']
    return {'duration_seconds':duration,'size_bytes':int(data['format']['size']),
        'width':stream['width'],'height':stream['height'],'codec':stream['codec_name'],
        'fps':float(Fraction(stream['avg_frame_rate'])),'time_base':stream['time_base'],
        'video_start_time':float(stream.get('start_time',0)),
        'frame_pts':[(int(frame['best_effort_timestamp']),float(frame['best_effort_timestamp_time'])) for frame in frame_data]}


def validate_clip(path,selection:TargetSelection,output_root:Path,identifier=None,hud_regions=None,batter_review=None):
    meta=metadata(path)
    if (selection.source_width,selection.source_height)!=(meta['width'],meta['height']):
        raise ValueError('Selection dimensions must match the source video')
    if selection.source_time>=meta['duration_seconds']:
        raise ValueError('Selection time exceeds the source duration')
    identifier=identifier or str(uuid4());folder=output_root/identifier
    folder.mkdir(parents=True,exist_ok=False)
    shutil.copyfile(path,folder/'source.mp4')
    tracker=ManualTargetTracker(selection)
    cap=cv2.VideoCapture(str(path));frames=PreviewFrames(folder/'.previews');boxes={};tracking=[];mapping=[];allowed_frames=[];header_observations=[]
    next_time=selection.source_time;first_pts=None;hud_observations=[]
    def scan():
        nonlocal next_time,first_pts
        try:
            for source_index,(pts,t) in enumerate(meta['frame_pts']):
                ok,frame=cap.read()
                if not ok:break
                if t+1e-8<next_time:continue
                while next_time<=t+1e-8:next_time+=.1
                if first_pts is None:first_pts=t
                clip_time=t-first_pts;sample_index=len(frames)
                state=tracker.update(frame,t);state['frame_index']=sample_index
                tracking.append(state)
                mapping.append({'frame_index':sample_index,'source_frame_index':source_index,
                    'source_time':t,'original_pts':pts,'time_base':meta['time_base'],
                    'segment_time':t-selection.source_time,'clip_time':clip_time,'frame_time':clip_time})
                # Only preview images are reduced. Pose sees the native-resolution target crop.
                preview=cv2.resize(frame,(960,round(frame.shape[0]*960/frame.shape[1])))
                pose_frame=None
                if state['analysis_allowed']:
                    box=expanded_roi(state['bbox'],meta['width'],meta['height'],selection.pose_margin)
                    pose_frame=crop(frame,box);boxes[clip_time]=box;allowed_frames.append(clip_time)
                    x,y,w,h=box;scale=960/frame.shape[1]
                    cv2.rectangle(preview,(round(x*scale),round(y*scale)),(round((x+w)*scale),round((y+h)*scale)),(80,210,210),2)
                cv2.putText(preview,'WONY MANUAL ROI - EXPERIMENTAL '+state['status'],(12,24),cv2.FONT_HERSHEY_SIMPLEX,.5,(255,255,255),1)
                frames.append((clip_time,preview))
                if sample_index%2==0:
                    header_observations.append(dict(pitching_header(frame),timestamp=clip_time,source_time=t))
                if sample_index%20==0:
                    cv2.imwrite(str(folder/f'evidence-{sample_index:04d}.jpg'),frame)
                if sample_index%2==0:
                    if hud_regions and selection.confirmed_by_user:
                        for label,region in hud_regions.items():
                            # Labels/ROIs are manual input, not an automatic HUD detector.
                            if label not in ('hud_original_speed','hud_converted_speed'):raise ValueError('Unsupported manual HUD label')
                            checked=TargetSelection(confirmed_by_user=True,viewpoint=selection.viewpoint,
                                source_width=meta['width'],source_height=meta['height'],bbox=tuple(region))
                            image=crop(frame,checked.bbox);filename=f'{label}-{sample_index:04d}.png'
                            cv2.imwrite(str(folder/filename),image)
                            hud_observations.append(dict(digit_observation(image,label,t,
                                f'/api/validation/{identifier}/evidence/{filename}'),clip_time=clip_time))
                if pose_frame is not None:yield clip_time,pose_frame
        finally:cap.release()
    stream=scan()
    try:
        first=next(stream,None)
        raw=extract_pose(chain([first],stream)) if first is not None else []
    finally:stream.close()
    if not frames:raise ValueError('No source frame at the selected time')
    # No full-frame fallback on target loss, first-person or missing confirmation.
    restored=[map_pose_to_source(sample,boxes[sample['time_seconds']],meta['width'],meta['height']) for sample in raw]
    target_boxes={m['clip_time']:f['bbox'] for m,f in zip(mapping,tracking)}
    mapped=[s for s in restored if pose_in_target(s,target_boxes[s['time_seconds']],meta['width'],meta['height'])]
    hud_votes=temporal_vote(hud_observations,'hud_original_speed')+temporal_vote(hud_observations,'hud_converted_speed')
    context=pitcher_context(mapped,header_observations,hud_votes)
    automatic=analyze_role(mapped,'auto','right',scene_context={'sbo_pitcher':context})
    role_result=automatic if selection.role_hint=='auto' else analyze_role(mapped,selection.role_hint,'right')
    if tracker.lost_at is not None:tracker.require_reidentification()
    result={'id':identifier,'schema_version':'0.4.0','sample_fps':10,'throwing_hand':'right',
        'synthetic_demo':False,'player_id':'wony' if selection.confirmed_by_user else None,
        'subject':{'player_id':'wony','name':'WONY','batting_hand':'right','throwing_hand':'right',
            'vr_tracking':'full_body','game':'SBO VR baseball','source':'user_provided'},
        'analysis_date':datetime.now(ZoneInfo('Asia/Seoul')).date().isoformat(),'created_at':datetime.now(timezone.utc).isoformat(),
        'sampled_frames':len(frames),'detected_pose_frames':len(mapped),'pose':mapped,
        'ball_speed':None,'batted_ball_speed':None,'comparison_context':None,
        'observation_method_version':'manual-roi-validation-v2',
        **role_result,
        'automatic_role_estimate':automatic.get('role_estimate'),
        'role_input':{'role_hint':selection.role_hint,'source':'user_provided' if selection.role_hint!='auto' else 'automatic','estimated':True,'confidence':None if selection.role_hint!='auto' else context['confidence']},
        'scene_context':{'sbo_pitcher':context,'header_observations':header_observations},
        'validation_only':True,'performance_assessment_validated':False,
        'target_tracking':{'selection':selection.model_dump(),'frames':tracking,
            'lost_at':tracker.lost_at,'status':tracker.status,'identity_source':'user_confirmation',
            'automatic_reidentification':False,'warning':'CSRT/appearance guards cannot guarantee identity through every occlusion; this is experimental'},
        'viewpoint_segments':[{'start':selection.source_time,'end':meta['duration_seconds'],
            'viewpoint':selection.viewpoint,'source':'manual_selection','manually_selected':True,'corrected_by_user':False,
            'automatic_classification':False}],
        'source_time_mapping':mapping,
        'hud_observations':hud_observations,'hud_temporal_votes':hud_votes,
        'game_hud_speed':game_speed_summary(hud_votes),
        'warnings':['Real clip validation, not a validated WONY scouting assessment.',
            'Detected landmark predictions are not all visible/valid joints; occluded joints remain low visibility and metrics keep their existing quality gates.',
            'No avatar appearance recognition; identity was confirmed by the user.',
            'Video/HUD label observations must not become physical speed.',
            'Estimated 3D visualization only; no true metric reconstruction.',
            'No bat detector/trail classifier is introduced by this harness.']}
    if len(pose_rows(mapped))<3:result['status']='insufficient_pose'
    elif result['role']!='unknown':result['status']='input_validation_only'
    result['assessment_gate']={'verified_repeated_pitches':0,'player_tools_allowed':False,'reason':'Input validation clip; no verified repeated plays or calibrated ability rubric'}
    gate_pitcher_phases(result,mapped,context)
    result['visualization']=build_visualization(frames,mapped,result,folder)
    restrict_3d(result['visualization'],mapped)
    shutil.rmtree(folder/'.previews')
    result['visualization']['source_time_mapping']=mapping
    old=f'/api/analysis/{identifier}/assets';new=f'/api/validation/{identifier}/assets'
    if result['visualization']['overlay_video_url']:
        result['visualization']['overlay_video_url']=result['visualization']['overlay_video_url'].replace(old,new)
    for keyframe in result['visualization']['keyframes']:
        if keyframe['image_url']:keyframe['image_url']=keyframe['image_url'].replace(old,new)
    result['scouting_report']=build_report(result)
    for play in result['scouting_report']['plays']:
        play['visualization_reference']['pose3d_json_url']=f'/api/validation/{identifier}/analysis'
    result['validation_summary']={'metadata':{k:v for k,v in meta.items() if k!='frame_pts'},
        'sampled_frames':len(frames),'tracking_allowed_frames':len(allowed_frames),
        'pose_detected_frames':len(raw),'usable_general_pose_frames':len(pose_rows(mapped)),
        'target_attributed_pose_frames':len(mapped),'pose_attribution_rejected_frames':len(raw)-len(mapped),
        'usable_pitcher_pose_frames':len(pose_rows(mapped,profile='pitcher')),
        'pose_quality':quality_report(mapped,len(frames)),
        'tracking_states':{state:sum(f['status']==state for f in tracking) for state in ['confirmed','tracking','low_confidence','temporary_occlusion','tracking_lost','reidentification_required']},
        'pose_margin':selection.pose_margin,
        'estimated_3d_frames':sum(bool(f['joints']) for f in result['visualization']['pose3d']['frames']),
        'sampling_policy':'10fps tracking/pose on native target crops; preview only at 960px',
        'sync_warning':'Overlay uses a 10fps display clock; original PTS mapping is retained separately; exact playback synchronization is not validated'}
    if batter_review is not None:
        from app.validation.batter_review import BatterReview,review_batter
        result['batter_validation']=review_batter(result,BatterReview.model_validate(batter_review))
    (folder/'analysis.json').write_text(json.dumps(result,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    return result
