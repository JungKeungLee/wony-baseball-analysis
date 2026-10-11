"""Compare like-for-like observations; do not infer player improvement from proxy deltas."""
from app.scouting.report import ROLE_NAMES, CATEGORIES


def compare_records(records):
    records = sorted(records, key=lambda r: (r['analysis_date'], r['created_at'], r['id']))
    previous = {}
    points = []
    for r in records:
        role = r['role']
        group = (role, bool(r.get('synthetic_demo')))
        prior = previous.get(group)
        context = r.get('comparison_context')
        comparisons = {}
        for name, m in r.get('metrics', {}).items():
            before = prior.get('metrics', {}).get(name) if prior else None
            reason = None
            if not prior:
                reason = 'No previous analysis for this role and source'
            elif not context or context != prior.get('comparison_context'):
                reason = 'Same explicit camera/task comparison_context required'
            elif r['status'] != 'completed' or prior['status'] != 'completed':
                reason = 'Both analyses must have sufficient pose'
            elif r.get('observation_method_version') != prior.get('observation_method_version') or not r.get('observation_method_version'):
                reason = 'Observation method versions differ or are unknown'
            elif r.get('throwing_hand') != prior.get('throwing_hand') or r.get('position_type') != prior.get('position_type'):
                reason = 'Throwing hand or fielding position differs'
            elif not before or m.get('unit') != before.get('unit') or m.get('method') != before.get('method'):
                reason = 'Observation units/methods differ'
            elif any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in [m.get('value'), before.get('value')]):
                reason = 'Numeric observations required'
            elif min(m.get('confidence', 0), before.get('confidence', 0)) < .4:
                reason = 'Observation confidence too low'
            comparable = reason is None
            comparisons[name] = {'value': m.get('value'), 'previous_value': before.get('value') if before else None,
                'delta': round(m['value']-before['value'], 6) if comparable else None,
                'unit': m.get('unit'), 'estimated': True,
                'confidence': min(m['confidence'], before['confidence']) if comparable else 0.0,
                'confidence_grade': 'medium' if comparable else 'low',
                'comparable': comparable, 'reason': reason,
                'interpretation': 'Image-proxy change only; not demonstrated skill improvement'}
        points.append({'analysis_id': r['id'], 'analysis_date': r['analysis_date'], 'role': role,
            'synthetic_demo': r['synthetic_demo'], 'previous_analysis_id': prior['id'] if prior else None,
            'comparison_context': context, 'ratings': r.get('ratings', {}),
            'rating_deltas': {name: None for name in ROLE_NAMES.values()},
            'criterion_scores': {f'{category}.{key}': {
                'score': None, 'previous_score': None, 'delta': None,
                'estimated': True, 'confidence': 0.0, 'confidence_grade': 'low',
                'reason': 'No validated reference scoring model; observations are stored separately'}
                for category, metrics in CATEGORIES.items() for key in metrics},
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
