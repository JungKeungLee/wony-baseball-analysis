def event(row, role, kind, metrics, confidence=.2):
    return {'timestamp': row['t'], 'role': role, 'type': kind,
            'estimated': True, 'confidence': confidence, 'confidence_grade': 'low',
            'candidate': True, 'metrics': metrics}
