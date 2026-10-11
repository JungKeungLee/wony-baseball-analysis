"""Scouting observations with provenance; proxy coverage is not player ability."""
from copy import deepcopy
import math
import numpy as np
from app.analysis.shared.pose_metrics import pose_rows
from app.scouting import proxies
from app.scouting.context import comparison_reason

TOOL_KEYS = ('contact', 'power', 'speed', 'fielding', 'arm')
TOOL_ROLES = {'contact': {'batter'}, 'power': {'batter'}, 'speed': {'baserunning'},
              'fielding': {'defense'}, 'arm': {'pitcher', 'defense', 'catcher'}}
TOOL_METRICS = {
    'contact': ['head_stability_score', 'hand_path_consistency_proxy', 'contact', 'impact_time'],
    'power': ['hip_rotation', 'shoulder_rotation', 'hip_shoulder_separation_proxy',
              'weight_transfer_score', 'hand_speed_proxy', 'hand_acceleration_proxy',
              'trunk_orientation_speed_proxy', 'follow_through'],
    'speed': ['running_speed_proxy', 'running_acceleration_proxy', 'cadence_proxy',
              'stride_frequency_proxy', 'stride_width_proxy', 'running_posture',
              'direction_change_proxy', 'deceleration_proxy', 'running_consistency_proxy', 'base_approach'],
    'fielding': ['first_step_time', 'first_step_direction', 'range_proxy', 'glove_position',
                'ready_stance', 'knee_flexion', 'footwork_path_proxy', 'balance', 'body_control_proxy',
                'forehand_backhand', 'throwing_transition'],
    'arm': ['arm_angle', 'elbow_angle', 'shoulder_angle', 'arm_elevation_proxy',
            'elbow_mechanics_proxy', 'shoulder_mechanics_proxy', 'arm_path_proxy', 'arm_speed_proxy',
            'balance', 'release_consistency', 'throwing_transition'],
}
ADDITIONAL = {
    'reaction': ['reaction_time', 'start_reaction'], 'balance': ['balance', 'balance_variability_proxy'],
    'footwork': ['footwork_path_proxy'], 'baserunning': ['running_posture', 'running_speed_proxy', 'direction_change_proxy'],
    'catching': ['receiving_posture', 'low_blocking_posture', 'mitt_movement', 'balance'],
    'timing': ['impact_time'], 'swing_consistency': ['hand_path_consistency_proxy'],
}
ROLE_ITEMS = {
    'batter': {'contact': TOOL_METRICS['contact'], 'power': TOOL_METRICS['power'],
        'timing': ['impact_time'], 'balance': ADDITIONAL['balance'],
        'swing_consistency': ['hand_path_consistency_proxy'], 'head_stability': ['head_stability_score'],
        'weight_transfer': ['weight_transfer_score']},
    'defense': {'fielding': TOOL_METRICS['fielding'], 'reaction': ['reaction_time'],
        'first_step': ['first_step_time', 'first_step_direction'], 'range_proxy': ['range_proxy'],
        'footwork': ADDITIONAL['footwork'], 'arm': TOOL_METRICS['arm'], 'balance': ADDITIONAL['balance']},
    'catcher': {'receiving': ['knee_flexion', 'center_height', 'receiving_posture'], 'blocking': ['low_blocking_posture'],
        'framing': ['framing'], 'glove_movement': ['mitt_movement'],
        'throwing_transition': ['transition_time'], 'arm': TOOL_METRICS['arm'], 'balance': ADDITIONAL['balance']},
    'pitcher': {'mechanics': ['torso_lean', 'arm_angle', 'elbow_angle', 'shoulder_angle'],
        'arm_slot': ['arm_angle'], 'release_consistency': ['release_consistency'],
        'lower_body_usage': ['lower_body_use'], 'stride': ['stride'], 'balance': ADDITIONAL['balance']},
    'baserunning': {'speed': TOOL_METRICS['speed'], 'start_reaction': ['start_reaction'],
        'acceleration': ['running_acceleration_proxy'], 'running_form': ['running_posture'],
        'direction_change': ['direction_change_proxy'], 'base_approach': ['base_approach'],
        'sliding': ['sliding'], 'decision_making': ['decision_making']},
}
SUMMARIES = {
    'contact': '머리·손 경로의 영상 움직임을 관찰합니다. 실제 컨택 여부와 타격 성공률은 확인되지 않았습니다.',
    'power': '파워 생성 동작의 2D 대리 지표입니다. 실제 힘·배트 속도·타구 속도·비거리는 평가하지 않습니다.',
    'speed': '주루 자세와 영상 내 이동을 관찰합니다. 실제 이동 속도·60야드 기록·베이스 도달 시간은 미측정입니다.',
    'fielding': '첫 이동·발 경로·중심 움직임을 관찰합니다. 타구 반응과 실제 포구 성공은 확인되지 않았습니다.',
    'arm': '팔·손목 경로와 자세의 참고 관찰입니다. 송구 여부·실제 구속·릴리스 정확성은 확인되지 않았습니다.',
}
ROLE_SUMMARIES = {
    'batter': '컨택 관련 움직임 안정성과 파워 생성 동작을 검토합니다. 컨택·타이밍·타구 강도 판단은 보류합니다.',
    'defense': '영상에서 첫 이동, 발 경로와 중심 제어를 검토합니다. 반응 속도·포구 성공·실제 수비 범위는 미확인입니다.',
    'catcher': '낮은 자세, 손목 이동과 밸런스를 검토합니다. 미트·공 추적 없는 프레이밍·포구 성공 평가는 보류합니다.',
    'pitcher': '기존 투구 자세와 팔 동작 관찰을 유지합니다. 실제 구속과 공 릴리스 일관성은 미측정입니다.',
    'baserunning': '주루 자세와 영상 내 움직임을 검토합니다. 출발 반응·베이스 접근·주루 판단은 확인되지 않았습니다.',
}
UNSUPPORTED = {'contact', 'impact_time', 'reaction_time', 'start_reaction', 'release_consistency',
    'throwing_transition', 'transition_time', 'forehand_backhand', 'framing', 'base_approach',
    'sliding', 'decision_making', 'actual_throw_velocity', 'exit_velocity', 'flight_distance',
    'bat_speed', 'actual_running_speed', 'sixty_yard_time', 'receiving_posture'}


def observation(key, metrics, applicable=True):
    value = deepcopy(metrics.get(key)) if applicable else None
    usable = value and value.get('value') is not None and value.get('confidence', 0) > 0
    if usable and isinstance(value['value'], (int, float)) and not isinstance(value['value'], bool):
        usable = math.isfinite(value['value'])
    status = 'estimated' if usable else 'not_supported' if applicable and key in UNSUPPORTED else 'insufficient_data'
    return {'metric': key, 'status': status, 'value': value['value'] if usable else None,
        'unit': value.get('unit') if value else None, 'estimated': True,
        'confidence': value['confidence'] if usable else 0.0,
        'confidence_grade': value.get('confidence_grade', 'low') if usable else 'low',
        'method': value.get('method') if value else None,
        'reason': (value.get('reason') if value else None) or (None if usable else
            'Required tracking/calibration or verified repeated actions are unavailable' if applicable else 'Role not analyzed')}


def evidence(result, plays):
    if result.get('status') != 'completed':
        return []
    # Whole-clip observations are linked to a review candidate, never relabeled play-local.
    play = plays[0] if plays else None
    return [{'analysis_id': result['id'], 'role': result['role'], 'scope': 'whole_clip',
        'synthetic_demo': bool(result.get('synthetic_demo')), 'play_id': play['id'] if play else None,
        'candidate': True, 'timestamp': play['timestamp'] if play else None,
        'visualization_reference': deepcopy(play['visualization_reference']) if play else {
            'analysis_id': result['id'], 'overlay_video_url': (result.get('visualization') or {}).get('overlay_video_url')},
        'reason': 'Clip observation; linked event is an unverified review candidate, not proof of contact/catch/throw'}]


def assessment(name, keys, metrics, applicable, refs):
    observations = [observation(key, metrics, applicable) for key in keys]
    supported = [m for m in observations if m['status'] == 'estimated']
    status = 'estimated' if supported else ('not_supported' if applicable and all(m['status'] == 'not_supported' for m in observations) else 'insufficient_data')
    confidence = min(m['confidence'] for m in supported) if supported else 0.0
    summary = SUMMARIES.get(name, '관측 가능한 2D 움직임만 제공합니다. 실제 경기 능력 판단은 보류합니다.') if supported else (
        '분석한 역할에 해당하는 데이터가 없습니다.' if not applicable else '필요한 동작·공 추적 또는 반복 데이터가 없어 판단을 보류합니다.')
    return {'status': status, 'score': None, 'grade': None, 'estimated': True,
        'confidence': confidence, 'confidence_grade': 'medium' if confidence >= .4 else 'low',
        'summary': summary, 'observations': observations,
        'evidence': deepcopy(refs) if supported else [],
        'reason': 'No independently validated scouting rubric; image proxies are not ability scores'}


def build_tools(result, plays):
    rows=pose_rows(result.get('pose',[]),result.get('throwing_hand','right'))
    computed = proxies.calculate(result, rows)
    window={'duration_seconds':rows[-1]['t']-rows[0]['t'], 'sample_count':len(rows),
            'max_gap_seconds':float(np.max(np.diff([r['t'] for r in rows])))} if len(rows)>=2 else None
    metrics = dict(result.get('metrics', {}), **computed)
    valid = result.get('status') == 'completed'
    refs = evidence(result, plays)
    tools = {name: assessment(name, TOOL_METRICS[name], metrics, valid and result['role'] in TOOL_ROLES[name], refs)
             for name in TOOL_KEYS}
    if result['role']=='baserunning' and not any(key in computed for key in ('running_speed_proxy','cadence_proxy')):
        tools['speed'].update(status='insufficient_data', confidence=0.0, confidence_grade='low', evidence=[],
            summary='주루 자세만으로 속도를 평가할 수 없습니다. 충분한 영상 내 이동이나 반복 발 동작이 없습니다.')
    for name, key in [('power', 'exit_velocity'), ('power', 'flight_distance'), ('power', 'bat_speed'),
                      ('arm', 'actual_throw_velocity'), ('speed', 'actual_running_speed'), ('speed', 'sixty_yard_time')]:
        tools[name]['observations'].append(observation(key, {}, valid and result['role'] in TOOL_ROLES[name]))
    additional = {name: assessment(name, keys, metrics, valid and
        (name != 'baserunning' or result['role'] == 'baserunning') and
        (name != 'catching' or result['role'] == 'catcher') and
        (name not in ('timing', 'swing_consistency') or result['role'] == 'batter'), refs)
        for name, keys in ADDITIONAL.items()}
    detail = {name: assessment(name, keys, metrics, valid, refs)
              for name, keys in ROLE_ITEMS.get(result['role'], {}).items()}
    return {'player_tools': tools, 'additional_evaluations': additional, 'proxy_metrics': computed,
        'role_summary': {'role': result['role'], 'position_type': result.get('position_type'),
            'summary': ROLE_SUMMARIES.get(result['role'], '역할 근거가 부족하여 판단을 보류합니다.') if valid else (
                '역할 근거가 부족하여 판단을 보류합니다.' if result.get('status')=='unknown_role' else '관절 데이터가 부족하여 평가를 보류합니다.'),
            'assessments': detail},
        'best_tool': None, 'development_area': None, 'play_style': None,
        'classification_reason': 'Comparable validated ability evidence is absent; no best tool, ranking or play style inferred',
        'tools_method_version': proxies.VERSION, 'movement_signature': hand_path_signature(result),
        'observation_window': window}


def hand_path_signature(result):
    if result.get('role') != 'batter' or result.get('status') != 'completed':
        return None
    timestamp = next((e['timestamp'] for e in result.get('events', []) if e.get('type') == 'swing'), None)
    if timestamp is None:
        return None
    rows = [row for row in pose_rows(result.get('pose', []), result.get('throwing_hand', 'right'))
            if timestamp-.3-1e-6 <= row['t'] <= timestamp+.3+1e-6]
    if len(rows) < 5 or rows[-1]['t']-rows[0]['t'] < .4-1e-6 or max(np.diff([row['t'] for row in rows])) > .25:
        return None
    if rows[0]['t'] > timestamp-.2+1e-6 or rows[-1]['t'] < timestamp+.2-1e-6:
        return None
    t = np.array([row['t']-timestamp for row in rows])
    path = np.array([(((row['xy'][15]+row['xy'][16])/2)-row['hips'])/row['torso'] for row in rows])
    points = np.array([np.interp(np.linspace(-.2, .2, 20), t, path[:, axis]) for axis in range(2)]).T
    return {'method': proxies.VERSION, 'candidate_timestamp': timestamp,
            'points': points.tolist(), 'estimated': True, 'confidence': .2}


def repeated_hand_path(results):
    """Aligned candidate paths, not contact/swing success consistency."""
    eligible = [r for r in results if r.get('role') == 'batter' and r.get('status') == 'completed'
                and (r.get('scouting_report') or {}).get('movement_signature')
                and comparison_reason(r, r) is None]
    if len(eligible) < 3:
        return None
    # Use the newest declared capture cohort; old incomplete captures cannot poison it.
    anchor = eligible[-1]
    aligned = [r for r in eligible if comparison_reason(r, anchor) is None]
    paths, ids = [], []
    for r in aligned:
        signature = r['scouting_report']['movement_signature']
        if signature.get('method') != proxies.VERSION:
            continue
        try:
            points = np.asarray(signature.get('points', []), dtype=float)
        except (TypeError, ValueError):
            continue
        if points.shape != (20, 2) or not np.isfinite(points).all():
            continue
        paths.append(points); ids.append(r['id'])
    if len(paths) < 3:
        return None
    center = np.median(paths, axis=0)
    value = float(np.sqrt(np.mean(np.sum((np.array(paths)-center)**2, axis=2))))
    return {'metric': 'hand_path_consistency_proxy', 'status': 'estimated', 'value': value,
        'unit': 'torso_lengths', 'estimated': True, 'confidence': .2, 'confidence_grade': 'low',
        'method': proxies.VERSION+': RMS deviation of candidate-aligned body-relative hand paths',
        'reason': 'At least three compatible clip candidates; not verified contact or actual swing repeatability',
        'sample_count': len(paths), 'scope': 'compatible_candidates', 'analysis_ids': ids}


def aggregate_tools(results):
    # Distinct clips only: never inflate evidence by duplicating an entry.
    unique = {r['id']: r for r in results}
    results = sorted(unique.values(), key=lambda r: (r.get('analysis_date') or '', r.get('created_at') or '', r['id']))
    reports = [(r, r.get('scouting_report') or {}) for r in results]
    sources = {bool(r.get('synthetic_demo')) for r in results}
    players = {r.get('player_id') for r in results}
    if len(sources) > 1 or len(players) > 1:
        return {'player_tools': {name: assessment(name, TOOL_METRICS[name], {}, False, []) for name in TOOL_KEYS},
            'best_tool': None, 'development_area': None, 'play_style': None,
            'classification_reason': 'Different identified/anonymous players or real/DEMO evidence cannot be combined',
            'synthetic_demo': sources == {True}, 'mixed_sources': len(sources) > 1,
            'mixed_players': len(players) > 1, 'repeated_movement': None}
    tools = {}
    for name in TOOL_KEYS:
        candidates = [(r, report['player_tools'][name]) for r, report in reports if name in report.get('player_tools', {}) and r['role'] in TOOL_ROLES[name]]
        usable = [(r, tool) for r, tool in candidates if tool['status'] == 'estimated']
        if usable:
            representative, tool = usable[-1]
            tools[name] = deepcopy(tool)
            tools[name]['representative_analysis_id'] = representative['id']
            tools[name]['evidence'] = [ref for _, candidate in usable for ref in candidate['evidence']]
            tools[name]['aggregation_policy'] = 'Latest applicable clip observations; no average across captures or roles'
            tools[name]['evidence_count'] = len({ref['analysis_id'] for ref in tools[name]['evidence']})
        else:
            tools[name] = deepcopy(candidates[-1][1]) if candidates else assessment(name, TOOL_METRICS[name], {}, False, [])
            tools[name]['evidence_count'] = 0
    repeat = repeated_hand_path(results) if len(sources) == 1 else None
    if repeat and tools['contact']['status'] == 'estimated':
        observations = tools['contact']['observations']
        observations[:] = [o for o in observations if o['metric'] != repeat['metric']]+[repeat]
        tools['contact']['confidence'] = min(tools['contact']['confidence'], repeat['confidence'])
        tools['contact']['confidence_grade'] = 'low'
    return {'player_tools': tools, 'best_tool': None, 'development_area': None, 'play_style': None,
        'classification_reason': 'No validated scouting ranking; sufficient comparable ability evidence is required',
        'synthetic_demo': sources == {True}, 'mixed_sources': len(sources) > 1,
        'mixed_players': False, 'player_identified': bool(players and None not in players),
        'repeated_movement': repeat}
