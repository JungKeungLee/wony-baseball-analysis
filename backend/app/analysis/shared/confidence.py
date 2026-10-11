def metric(value=None, unit=None, method=None, confidence=0.0, reason=None):
    score = max(0.0, min(float(confidence), 1.0)) if value is not None else 0.0
    return {'value': value, 'unit': unit, 'estimated': True,
            'confidence': round(score, 3),
            'confidence_grade': 'high' if score >= .75 else 'medium' if score >= .4 else 'low',
            'method': method, 'reason': (reason or 'Degenerate or unavailable measurement') if value is None else None}


def missing(names, reason='Insufficient visible pose data'):
    return {name: metric(reason=reason) for name in names}


def feedback(metrics):
    strengths, weaknesses, coaching = [], [], []
    for key, threshold in [('head_stability_score', .15), ('balance', .35)]:
        m = metrics.get(key, {})
        if m.get('value') is None or m.get('confidence', 0) < .4:
            continue
        stable = m['value'] <= threshold
        label = '머리' if key == 'head_stability_score' else '골반 중심'
        target = strengths if stable else weaknesses
        target.append({'metric': key, 'text': f'영상에서 {label} 변화가 작습니다.' if stable else f'영상에서 {label} 변화가 큽니다.',
                       'estimated': True, 'confidence': m['confidence'],
                       'confidence_grade': m['confidence_grade']})
        if not stable:
            coaching.append({'text': '고정 카메라 영상에서 머리와 골반 이동을 다시 확인하세요.',
                             'metric': key, 'estimated': True, 'confidence': m['confidence'],
                             'confidence_grade': m['confidence_grade']})
    return dict(strengths=strengths, weaknesses=weaknesses, coaching=coaching)
