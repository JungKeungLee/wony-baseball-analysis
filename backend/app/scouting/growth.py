"""Compare like-for-like observations; do not infer player improvement from proxy deltas."""
from app.scouting.report import ROLE_NAMES, CATEGORIES
from app.scouting.context import comparison_reason
import math


def numeric_change(current, before, compatibility_reason, minimum_confidence=.4):
    reason = compatibility_reason
    if not reason:
        if not before or not current.get('unit') or not current.get('method') or current.get('unit') != before.get('unit') or current.get('method') != before.get('method'):
            reason = 'Observation units/methods differ'
        elif any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
                 for v in [current.get('value'), before.get('value')]):
            reason = 'Finite numeric observations required'
        elif min(current.get('confidence', 0), before.get('confidence', 0)) < minimum_confidence:
            reason = 'Observation confidence too low'
    comparable = reason is None
    confidence = min(current['confidence'], before['confidence']) if comparable else 0.0
    return {'value': current.get('value'), 'previous_value': before.get('value') if before else None,
        'delta': round(current['value']-before['value'], 6) if comparable else None,
        'unit': current.get('unit'), 'estimated': True, 'confidence': confidence,
        'confidence_grade': 'medium' if confidence >= .4 else 'low',
        'comparable': comparable, 'reason': reason,
        'interpretation': 'Image-proxy change only; not demonstrated skill improvement'}


def compare_records(records):
    records = sorted(records, key=lambda r: (r['analysis_date'], r['created_at'], r['id']))
    previous = {}
    points = []
    for r in records:
        role = r['role']
        group = (role, bool(r.get('synthetic_demo')))
        prior = previous.get(group)
        context = r.get('comparison_context')
        compatibility_reason = comparison_reason(r, prior)
        comparisons = {}
        for name, m in r.get('metrics', {}).items():
            before = prior.get('metrics', {}).get(name) if prior else None
            comparisons[name] = numeric_change(m, before, compatibility_reason)
        tool_changes = {}
        for name, tool in (r.get('scouting_report') or {}).get('player_tools', {}).items():
            old_tool = ((prior or {}).get('scouting_report') or {}).get('player_tools', {}).get(name, {})
            old_observations = {m['metric']: m for m in old_tool.get('observations', [])}
            tool_changes[name] = {m['metric']: numeric_change(m, old_observations.get(m['metric']), compatibility_reason, .2)
                for m in tool.get('observations', [])}
        points.append({'analysis_id': r['id'], 'analysis_date': r['analysis_date'], 'role': role,
            'synthetic_demo': r['synthetic_demo'], 'previous_analysis_id': prior['id'] if prior else None,
            'comparison_context': context, 'ratings': r.get('ratings', {}),
            'rating_deltas': {name: None for name in ROLE_NAMES.values()},
            'criterion_scores': {f'{category}.{key}': {
                'score': None, 'previous_score': None, 'delta': None,
                'estimated': True, 'confidence': 0.0, 'confidence_grade': 'low',
                'reason': 'No validated reference scoring model; observations are stored separately'}
                for category, metrics in CATEGORIES.items() for key in metrics},
            'comparison_compatible': compatibility_reason is None, 'comparison_reason': compatibility_reason,
            'capture_context': r.get('capture_context'), 'tool_changes': tool_changes,
            'observations': comparisons})
        previous[group] = r
    return points


def illustrative_demo_growth():
    return {'synthetic_demo': True, 'player_id': 'DEMO-PLAYER',
        'label': 'DEMO · 구조 설명용 임의 점수이며 실제 영상 계산/선수 평가가 아닙니다.',
        'rating_label': '영상 기반 참고 지표 예시 — 공식 스카우팅 점수 아님',
        'metric': 'batting.balance', 'unit': 'illustrative_reference_index',
        'points': [{'session': label, 'value': value, 'delta': delta, 'estimated': True,
                    'confidence': 0.0, 'confidence_grade': 'low', 'synthetic_demo': True}
                   for label, value, delta in [('첫 연습', 62, None), ('다음 연습', 71, 9), ('최근 경기', 77, 6)]]}
