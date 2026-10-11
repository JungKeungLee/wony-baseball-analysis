"""Evidence-first reports. Pose visibility alone cannot justify scouting scores."""
from copy import deepcopy

ROLE_NAMES = {'batter': 'batting', 'defense': 'defense', 'catcher': 'catching',
              'pitcher': 'pitching', 'baserunning': 'baserunning'}
CATEGORIES = {
    'batting': {'contact': 'contact', 'timing': 'impact_time', 'balance': 'balance',
        'swing_consistency': None, 'weight_transfer': 'weight_transfer_score',
        'head_stability': 'head_stability_score', 'hip_rotation': 'hip_rotation',
        'shoulder_rotation': 'shoulder_rotation'},
    'defense': {'reaction': 'reaction_time', 'first_step': 'first_step_time',
        'fielding': 'fielding_center', 'footwork': 'footwork', 'glove_position': 'glove_position',
        'throwing_transition': 'throwing_transition', 'balance': 'balance', 'range': None},
    'catching': {'receiving': 'receiving_posture', 'blocking': 'low_blocking_posture',
        'framing': 'framing', 'throwing_transition': 'transition_time',
        'stability': 'center_position', 'balance': 'balance'},
    'pitching': {'mechanics': 'torso_lean', 'balance': 'balance',
        'release_consistency': None, 'lower_body_usage': 'lower_body_use'},
    'baserunning': {k: k for k in ['start_reaction', 'acceleration', 'running_posture',
        'direction_change', 'base_approach', 'sliding', 'decision_making']},
}
NO_SCORE = 'No calibrated reference scoring rubric or validated performance measurement; not enough evidence for a score/grade'


def role_evaluations(result):
    current = ROLE_NAMES.get(result['role'])
    evaluations = {}
    for category, items in CATEGORIES.items():
        metrics = {}
        for item, key in items.items():
            observation = deepcopy(result['metrics'].get(key)) if category == current and key else None
            reason = NO_SCORE
            if category != current:
                reason = 'Role not analyzed in this video'
            elif item in ['swing_consistency', 'release_consistency']:
                reason = 'Requires multiple verified, aligned plays; one candidate is insufficient'
            elif observation is None or observation.get('value') is None:
                reason = (observation or {}).get('reason') or 'Required ball/field/action evidence is unavailable'
            metrics[item] = {'score': None, 'grade': None, 'estimated': True,
                'confidence': 0.0, 'confidence_grade': 'low', 'reason': reason,
                'observation': observation, 'evidence_metric': key}
        evaluations[category] = {'analyzed': category == current, 'rating': None,
            'metrics': metrics, 'strengths': deepcopy(result.get('strengths', [])) if category == current else [],
            'development_areas': deepcopy(result.get('weaknesses', [])) if category == current else [],
            'coaching': deepcopy(result.get('coaching', [])) if category == current else []}
    return evaluations


def play_evaluations(result):
    output = []
    visual = result['visualization']
    for number, source_event in enumerate(result['events'], 1):
        timestamp = source_event['timestamp']
        frames = visual['pose3d']['frames']
        frame = min(frames, key=lambda f: abs(f['timestamp']-timestamp)) if frames else None
        if frame and abs(frame['timestamp']-timestamp) > .051:
            frame = None
        keyframes = [k for k in visual['keyframes'] if k['frame'] is not None]
        keyframe = min(keyframes, key=lambda k: abs(k['timestamp']-timestamp)) if keyframes else None
        if keyframe and (not frame or keyframe['frame'] != frame['frame']):
            keyframe = None
        # Feedback is confined to local angles. Whole-clip feedback must not be mislabeled as play-local evidence.
        local_metrics = deepcopy(keyframe['angles']) if keyframe and frame and keyframe['frame'] == frame['frame'] else {}
        coaching = []
        if local_metrics:
            coaching.append({'text': '후보 프레임의 2D 관절 각도를 함께 확인하세요. 정상/이상 또는 성공/실패 판정이 아닙니다.',
                'scope': 'keyframe_review', 'estimated': True,
                'confidence': source_event['confidence'], 'confidence_grade': source_event['confidence_grade']})
        output.append({
            'id': f"{result['id']}:play:{number}", 'role': result['role'],
            'event': deepcopy(source_event), 'timestamp': timestamp,
            'estimated': True, 'confidence': source_event['confidence'],
            'confidence_grade': source_event['confidence_grade'], 'candidate': True,
            'metrics': local_metrics, 'strengths': [], 'weaknesses': [], 'coaching': coaching,
            'assessment_reason': 'Unverified event candidate; no calibrated play-specific performance assessment',
            'context_feedback': {'scope': 'whole_clip', 'strengths': deepcopy(result.get('strengths', [])),
                'weaknesses': deepcopy(result.get('weaknesses', [])), 'coaching': deepcopy(result.get('coaching', []))},
            'keyframe': deepcopy(keyframe),
            'visualization_reference': {'analysis_id': result['id'],
                'overlay_video_url': visual['overlay_video_url'],
                'frame': frame['frame'] if frame else None,
                'pose3d_frame': frame['frame'] if frame and frame['joints'] else None,
                'pose3d_json_url': f"/api/analysis/{result['id']}",
                'keyframe_image_url': keyframe['image_url'] if keyframe else None},
        })
    return output


def build_report(result):
    role = ROLE_NAMES.get(result['role'])
    traits = [{'metric': name, 'observation': deepcopy(value), 'estimated': True,
               'confidence': value['confidence'], 'confidence_grade': value['confidence_grade']}
              for name, value in result['metrics'].items()
              if value['value'] is not None and value['confidence'] >= .4]
    summary = ('관절 데이터가 부족하여 선수 평가를 보류합니다.' if result['status'] == 'insufficient_pose'
        else '역할을 확인하지 못해 선수 평가를 보류합니다.' if role is None
        else f'{role} 영상에서 2D 자세 관찰을 제공했습니다. 실제 경기 능력과 공식 스카우팅 점수는 판정하지 않습니다.')
    if result['synthetic_demo']:
        summary = 'DEMO · 합성 관절/영상이며 실제 선수 평가가 아닙니다. ' + summary
    return {
        'player_id': result['player_id'], 'analysis_date': result['analysis_date'],
        'synthetic_demo': result['synthetic_demo'], 'estimated': True,
        'rating_label': '영상 기반 참고 지표 — 프로 스카우터 공식 점수 아님',
        'scoring_policy': 'No numeric grades until an independently validated rubric and sufficient evidence exist',
        'strengths': deepcopy(result.get('strengths', [])),
        'development_areas': deepcopy(result.get('weaknesses', [])),
        'traits': traits, 'overall_summary': summary,
        'ratings': {name: None for name in CATEGORIES},
        'rating_reasons': {name: NO_SCORE if name == role else 'Role not analyzed' for name in CATEGORIES},
        'role_evaluations': role_evaluations(result), 'plays': play_evaluations(result),
    }


def aggregate_player_report(player_id, records, source):
    latest = {}
    for record in records:
        category = ROLE_NAMES.get(record['role'])
        if category:
            latest[category] = record
    strengths, development, traits = [], [], []
    for category, record in latest.items():
        report = record['scouting_report']
        for target, key in [(strengths, 'strengths'), (development, 'development_areas'), (traits, 'traits')]:
            target.extend(dict(item, category=category, analysis_id=record['id'], analysis_date=record['analysis_date'])
                          for item in report.get(key, []))
    return {'player_id': player_id, 'source': source, 'synthetic_demo': source == 'demo',
        'overall_summary': ('DEMO · ' if source == 'demo' else '') +
            f'{len(records)}개 기록, {len(latest)}개 역할의 최근 관찰입니다. 선수의 실제 경기 능력을 점수로 확정하지 않습니다.',
        'rating_label': '영상 기반 참고 지표 — 프로 스카우터 공식 점수 아님',
        'ratings': {key: None for key in CATEGORIES}, 'strengths': strengths,
        'development_areas': development, 'traits': traits,
        'roles': {key: {'analysis_id': latest[key]['id'], 'analysis_date': latest[key]['analysis_date'],
                'evaluation': latest[key]['scouting_report']['role_evaluations'][key],
                'plays': latest[key]['scouting_report']['plays']} if key in latest else None for key in CATEGORIES}}
