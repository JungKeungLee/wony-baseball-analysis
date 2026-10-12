"""Read-only list of stored WONY validation results.

Summaries are read from the existing ``data/validation/{id}/analysis.json``
files. Nothing is recomputed, and these records never enter player growth
history. Broken or incomplete result folders are skipped and counted.
"""
import json
import math
from pathlib import Path
from uuid import UUID

SOURCE_FILE = 'upload.json'
_cache = {}


def save_source_name(folder, name):
    """Keep only the uploaded file's base name for display; never the video itself."""
    clean = Path(str(name or '').replace('\\', '/')).name.strip()[:200]
    if clean:
        (Path(folder) / SOURCE_FILE).write_text(json.dumps({'source_name': clean}, ensure_ascii=False), encoding='utf-8')


def _source_name(folder):
    try:
        value = json.loads((folder / SOURCE_FILE).read_text(encoding='utf-8')).get('source_name')
        return value if isinstance(value, str) and value else None
    except (OSError, ValueError, AttributeError):
        return None


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _tools(report):
    tools = [t for t in ((report or {}).get('player_tools') or {}).values() if isinstance(t, dict)]
    scored = sum(t.get('score') is not None for t in tools)
    if not tools:status = 'not_available'
    elif scored:status = 'scored' if scored == len(tools) else 'partial'
    elif all(t.get('status') == 'insufficient_data' for t in tools):status = 'insufficient_data'
    else:status = 'withheld'
    return status, scored, len(tools)


def summarize(folder):
    folder = Path(folder)
    UUID(folder.name)
    data = json.loads((folder / 'analysis.json').read_text(encoding='utf-8'))
    if not isinstance(data, dict) or data.get('id') != folder.name or data.get('validation_only') is not True:
        raise ValueError('Not a validation result')
    tracking = data.get('target_tracking') or {}
    summary = data.get('validation_summary') or {}
    role_input = data.get('role_input') or {}
    automatic = data.get('automatic_role_estimate') or {}
    tools_status, scored, total = _tools(data.get('scouting_report'))
    lost_at = _number(tracking.get('lost_at'))
    return {
        'id': folder.name, 'created_at': data.get('created_at'), 'analysis_date': data.get('analysis_date'),
        'role': data.get('role'), 'role_source': role_input.get('source'), 'role_hint': role_input.get('role_hint'),
        'automatic_role': automatic.get('value'),
        'duration_sec': _number((summary.get('metadata') or {}).get('duration_seconds')),
        'tracking_status': tracking.get('status'), 'tracking_lost_at': lost_at,
        'reidentification_required': lost_at is not None,
        'viewpoint': (tracking.get('selection') or {}).get('viewpoint'),
        'report_status': 'completed', 'analysis_status': data.get('status'),
        'player_tools_status': tools_status, 'player_tools_scored': scored, 'player_tools_total': total,
        'sampled_frames': summary.get('sampled_frames'),
        'usable_full_body_frames': summary.get('usable_general_pose_frames'),
        'estimated_3d_frames': summary.get('estimated_3d_frames'),
        'source_name': _source_name(folder),
        'synthetic_demo': bool(data.get('synthetic_demo')), 'validation_only': True,
        'growth_history_included': False,
        'report_url': f'/demo/validation/report/{folder.name}'}


def _cached(folder):
    stamps = tuple((p.stat().st_mtime_ns, p.stat().st_size) if p.exists() else None
                   for p in (folder / 'analysis.json', folder / SOURCE_FILE))
    hit = _cache.get(folder)
    if hit and hit[0] == stamps:return hit[1]
    item = summarize(folder)
    _cache[folder] = (stamps, item)
    return item


def list_reports(root, offset=0, limit=30):
    items, skipped = [], 0
    for folder in Path(root).iterdir() if Path(root).is_dir() else []:
        if not folder.is_dir():continue
        try:UUID(folder.name)
        except ValueError:continue
        if not (folder / 'analysis.json').is_file():
            skipped += 1  # still running, or interrupted before the result was written
            continue
        try:items.append(_cached(folder))
        except (OSError, ValueError, TypeError, KeyError, AttributeError):skipped += 1
    items.sort(key=lambda i: (str(i['created_at'] or ''), i['id']), reverse=True)
    return {'items': items[offset:offset + limit], 'total': len(items), 'offset': offset, 'limit': limit,
            'skipped': skipped, 'growth_history_included': False}
