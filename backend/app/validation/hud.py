"""Optional numeric OCR of manually labeled SBO HUD crops; never physical speed.

English Tesseract can read digits but not validate Korean labels or game semantics.
Every observation requires review and has no inferred pitch/event association.
"""
import csv
import io
import re
import shutil
import subprocess
import cv2


def numeric_hud(image,label,timestamp,evidence_reference=None,*,digits_only=False,threshold=180):
    if not shutil.which('tesseract'):
        return {'status':'not_supported','value':None,'reason':'Optional Tesseract executable unavailable'}
    gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)
    gray=cv2.resize(gray,None,fx=3,fy=3)
    _,binary=cv2.threshold(gray,threshold,255,cv2.THRESH_BINARY)
    ok,png=cv2.imencode('.png',255-binary)
    if not ok:raise ValueError('Cannot encode OCR crop')
    command=['tesseract','stdin','stdout','-l','eng','--psm','7' if digits_only else '6']
    # The crop contains only digits; a whitelist destroys Tesseract confidence
    # on this italic HUD. Decimal-only parsing below rejects nonnumeric output.
    result=subprocess.run(command+['tsv'],
        input=png.tobytes(),capture_output=True,check=True,timeout=20)
    tokens=list(csv.DictReader(io.StringIO(result.stdout.decode('utf-8')),delimiter='\t'))
    candidates=[]
    for token in tokens:
        text=token.get('text','')
        # Label-local crop and a decimal point required; never guess a missing decimal.
        for match in [m for m in [re.fullmatch(r'(\d{1,3}\.\d{1,2})',text.strip())] if m]:
            candidates.append((float(match[1]),max(0,float(token['conf']))/100))
    unique={value for value,_ in candidates}
    value=next(iter(unique)) if len(unique)==1 else None
    confidence=min((c for v,c in candidates if v==value),default=0.0)
    return {'metric':label,'timestamp':timestamp,'status':'insufficient_data',
        'value':None,'unit':None,'ocr_candidate':value,'candidate_unit':'km/h',
        'unit_source':'manual_visual_label',
        'source':'sbo_hud_estimated','estimated':True,'confidence':0.0,'ocr_confidence':round(confidence,3),
        'review_required':True,'event_id':None,'event_association_verified':False,
        'physical_velocity':None,'evidence_reference':evidence_reference,
        'reason':'Unconfirmed OCR candidate, not a measurement. Cropping can change digits even at nonzero OCR confidence; visual review and event association required'}


def digit_observation(image,label,timestamp,evidence_reference=None):
    """Two preprocessing votes are diagnostics; temporal votes are still required."""
    observations=[numeric_hud(image,label,timestamp,evidence_reference,digits_only=True,threshold=v) for v in (160,170)]
    first=dict(observations[0]);values=[o.get('ocr_candidate') for o in observations]
    first['preprocessing_thresholds']=[160,170]
    first['preprocessing_candidates']=values
    if values[0] is None or values[0]!=values[1]:
        first.update(ocr_candidate=None,ocr_confidence=0.0,reason='Preprocessing disagreement')
    else:first['ocr_confidence']=min(o.get('ocr_confidence',0) for o in observations)
    return first


def temporal_vote(observations,label,window_seconds=1.2,max_game_display_value=300):
    """Consecutive distinct-time observations; never average different HUD values.

    Conservative acceptance policy: >=5 frames, >=80% agreement, >=4 supporting
    readings with OCR confidence >=0.7, >=0.6s span, no sampling gap >0.35s.
    Decimal format is mandatory. 0..300 is a configurable application guard,
    not an assertion about the game's limits or physical baseball speed.
    """
    from collections import Counter
    import math
    ordered=sorted((o for o in observations if o.get('metric')==label),key=lambda o:o['timestamp'])
    output=[]
    for i,current in enumerate(ordered):
        window=[o for o in ordered[:i+1] if current['timestamp']-o['timestamp']<=window_seconds+1e-8]
        unique={o['timestamp']:o for o in window};window=list(unique.values())
        valid=[o for o in window if isinstance(o.get('ocr_candidate'),(int,float)) and math.isfinite(o['ocr_candidate']) and 0<=o['ocr_candidate']<=max_game_display_value and .7<=o.get('ocr_confidence',0)<=1]
        counts=Counter(o['ocr_candidate'] for o in valid)
        winner,count=counts.most_common(1)[0] if counts else (None,0)
        ratio=count/len(window) if window else 0
        support=[o for o in valid if o['ocr_candidate']==winner]
        gaps=[b['timestamp']-a['timestamp'] for a,b in zip(window,window[1:])]
        accepted=(len(window)>=5 and count>=4 and ratio>=.8 and
            window[-1]['timestamp']-window[0]['timestamp']>=.6 and max(gaps,default=99)<=.35 and
            current.get('ocr_candidate')==winner and current.get('ocr_confidence',0)>=.7)
        output.append({'metric':label,'timestamp':current['timestamp'],'clip_time':current.get('clip_time',current['timestamp']),'value':winner if accepted else None,
            'unit':'km/h' if accepted else None,'source':'sbo_hud_observed' if accepted else 'sbo_hud_estimated',
            'estimated':True,'confidence':round(min(ratio,min((o['ocr_confidence'] for o in support),default=0),.9),3) if accepted else 0,
            'review_required':not accepted,'candidate':winner,'supporting_frames':count,'window_frames':len(window),
            'window_start':window[0]['timestamp'],'agreement':round(ratio,3),
            'event_id':None,'event_association_verified':False,'physical_velocity':None,
            'method':'manual_label_numeric_crop_dual_preprocess_temporal_vote_v1',
            'accuracy_verified':False,'evidence_references':[o.get('evidence_reference') for o in support],
            'reason':None if accepted else 'Insufficient consecutive high-confidence decimal agreement'})
    return output


def game_speed_summary(votes):
    """Keep raw/converted fields distinct; no inferred pitch/event count."""
    latest={}
    for item in sorted(votes,key=lambda v:v['timestamp']):latest[item['metric']]=item
    accepted={key:item for key,item in latest.items() if item['value'] is not None}
    return {'raw_game_speed':accepted.get('hud_original_speed',{}).get('value'),
        'converted_game_speed_kmh':accepted.get('hud_converted_speed',{}).get('value'),
        'source':'sbo_hud_observed' if accepted else 'sbo_hud_estimated',
        'estimated':True,'review_required':len(accepted)<2,'physical_velocity':None,
        'timestamp_by_field':{key:value['timestamp'] for key,value in latest.items()},
        'same_pitch_association_verified':False,
        'warning':'Latest reviewed game display state per field; unconfirmed current readings stay null. Not physical velocity or a verified pitch.'}
