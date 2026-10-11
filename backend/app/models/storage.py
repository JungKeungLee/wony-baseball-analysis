import json
import os
from pathlib import Path


def data_dir():
    root = Path(os.getenv('WONY_DATA_DIR', Path(__file__).resolve().parents[3] / 'data'))
    root.mkdir(parents=True, exist_ok=True)
    return root


def save_result(result):
    path = data_dir() / f"{result['id']}.json"
    temporary = path.with_suffix('.tmp')
    try:
        temporary.write_text(json.dumps(result, allow_nan=False), encoding='utf-8')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def player_records(player_id, source='real'):
    """Read only UUID result files, never use player identifiers as filesystem paths."""
    import re
    records, skipped = [], 0
    for path in data_dir().glob('*.json'):
        if not re.fullmatch(r'[0-9a-fA-F-]{36}\.json', path.name):
            continue
        try:
            result = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(result, dict):
                skipped += 1
                continue
            if result.get('player_id') != player_id or bool(result.get('synthetic_demo', False)) != (source == 'demo'):
                continue
            if not all(result.get(key) for key in ['id', 'role', 'analysis_date', 'created_at']):
                skipped += 1
                continue
            from datetime import date, datetime
            date.fromisoformat(result['analysis_date'])
            datetime.fromisoformat(result['created_at'])
            report = result.get('scouting_report') or {}
            if not isinstance(result.get('metrics'), dict) or not isinstance(report.get('role_evaluations'), dict):
                skipped += 1
                continue
            records.append({key: result.get(key) for key in ['id', 'role', 'analysis_date', 'created_at',
                'synthetic_demo', 'comparison_context', 'capture_context', 'player_id', 'observation_method_version',
                'throwing_hand', 'position_type', 'status', 'metrics']} | {
                'ratings': report.get('ratings', {}), 'scouting_report': report})
        except (OSError, ValueError, TypeError):
            skipped += 1
    return sorted(records, key=lambda r: (r['analysis_date'], r['created_at'], r['id'])), skipped
