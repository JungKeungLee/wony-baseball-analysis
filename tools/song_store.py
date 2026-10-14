"""songs.json / 곡 파일 관리: ID 발급, staging(미리보기용 임시 저장), 원자적 등록, 삭제.

등록 순서 (중간에 실패하면 아무것도 남기지 않음)
  staging 의 4개 채보 재검증 → cover/video 존재 확인 → 최종 경로에 .tmp 로 복사 후 rename
  → 새 songs.json 검증 → songs.json 을 .tmp 로 쓰고 rename (이 순간 곡이 등록됨)
songs.json 이 가장 마지막에 바뀌므로, 사이트는 파일이 없는 곡을 가리키지 않는다.
"""
import contextlib
import json
import os
import re
import secrets
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from chart_config import DIFFICULTIES
from chart_generator import validate_chart, validate_set

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'frontend-demo'
STAGING = ROOT / '.import-staging'
ID_PREFIX = 'wony-cover-'
ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{1,47}$')


class StoreError(RuntimeError):
    pass


class Paths:
    def __init__(self, site=SITE):
        self.site = Path(site)
        self.songs_json = self.site / 'songs' / 'songs.json'
        self.charts = self.site / 'songs' / 'charts'
        self.videos = self.site / 'assets' / 'videos'
        self.covers = self.site / 'assets' / 'covers'

    def video(self, song_id):
        return self.videos / f'{song_id}.mp4'

    def cover(self, song_id):
        return self.covers / f'{song_id}.webp'

    def chart(self, song_id, diff, lane_count=4):
        """4키 = {id}-{diff}.json (기존), 6/8키 = {id}-{diff}-{n}k.json (게임 js/catalog.js chartUrl 과 같은 규칙)"""
        suffix = '' if lane_count == 4 else f'-{lane_count}k'
        return self.charts / f'{song_id}-{diff}{suffix}.json'


def write_json_atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    with open(tmp, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write('\n')
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def compact_chart_json(chart):
    """노트는 한 줄에 하나 (사람이 읽고 고치기 쉽게)."""
    head = {k: v for k, v in chart.items() if k != 'notes'}
    body = json.dumps(head, ensure_ascii=False, indent=2)[:-2]
    notes = ',\n'.join('    ' + json.dumps(n, separators=(',', ':')) for n in chart['notes'])
    return f'{body},\n  "notes": [\n{notes}\n  ]\n}}\n'


def write_chart(path, chart):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(compact_chart_json(chart), encoding='utf-8', newline='\n')
    os.replace(tmp, path)


def load_catalog(paths):
    if not paths.songs_json.exists():
        return {'version': 1, 'songs': []}
    data = json.loads(paths.songs_json.read_text(encoding='utf-8'))
    if not isinstance(data.get('songs'), list):
        raise StoreError('songs.json 형식이 올바르지 않습니다 (songs 배열 없음).')
    return data


def _staged_ids(staging):
    ids = set()
    for manifest in Path(staging).glob('*/stage.json'):
        with contextlib.suppress(Exception):
            ids.add(json.loads(manifest.read_text(encoding='utf-8'))['songId'])
    return ids


def taken_ids(paths, staging=STAGING, *, include_staging=True):
    ids = {s.get('id') for s in load_catalog(paths)['songs']}
    for folder, suffix in ((paths.videos, '.mp4'), (paths.covers, '.webp')):
        if folder.exists():
            ids |= {p.name[:-len(suffix)] for p in folder.glob(f'*{suffix}')}
    if paths.charts.exists():
        for p in paths.charts.glob('*.json'):
            for d in DIFFICULTIES:
                if p.name.endswith(f'-{d}.json'):
                    ids.add(p.name[:-len(f'-{d}.json')])
    if include_staging:
        ids |= _staged_ids(staging)
    return ids


def allocate_id(paths, staging=STAGING, *, include_staging=True):
    """wony-cover-01, wony-cover-02 … 비어 있는 다음 번호 (제목이 한글이어도 경로는 항상 ASCII)."""
    taken = taken_ids(paths, staging, include_staging=include_staging)
    nums = [int(m.group(1)) for i in taken if i and (m := re.fullmatch(rf'{ID_PREFIX}(\d+)', i))]
    n = max(nums, default=0) + 1
    while f'{ID_PREFIX}{n:02d}' in taken:
        n += 1
    return f'{ID_PREFIX}{n:02d}'


def check_custom_id(song_id, paths, staging=STAGING):
    if not ID_RE.fullmatch(song_id or ''):
        raise StoreError('곡 ID 는 영문 소문자/숫자/하이픈 2~48자여야 합니다.')
    if song_id in taken_ids(paths, staging):
        raise StoreError(f'이미 있는 곡 ID 입니다: {song_id}')
    return song_id


def new_stage_dir(staging=STAGING):
    stage_id = datetime.now().strftime('%Y%m%d-%H%M%S-') + secrets.token_hex(3)
    path = Path(staging) / stage_id
    path.mkdir(parents=True)
    return path


@contextlib.contextmanager
def catalog_lock(paths, timeout=15):
    lock = paths.songs_json.with_name('songs.json.lock')
    lock.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + timeout
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            with contextlib.suppress(OSError):
                if time.time() - lock.stat().st_mtime > 600:  # 비정상 종료로 남은 잠금
                    lock.unlink()
                    continue
            if time.time() > deadline:
                raise StoreError('다른 곡 등록 작업이 진행 중입니다. 잠시 후 다시 시도하세요.') from None
            time.sleep(0.2)
    try:
        os.close(fd)
        yield
    finally:
        with contextlib.suppress(OSError):
            lock.unlink()


def song_entry(song_id, manifest):
    return {
        'id': song_id,
        'title': manifest['title'],
        'artist': manifest.get('artist') or 'WONY',
        'cover': f'/assets/covers/{song_id}.webp',
        'video': f'/assets/videos/{song_id}.mp4',
        'difficulties': list(DIFFICULTIES),
        'durationMs': manifest['durationMs'],
        'bpm': manifest['analysis']['bpm'],
        'musicStartMs': manifest['analysis']['musicStartMs'],
        'noteCounts': manifest['noteCounts'],
        'generated': True,
        'addedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    }


def validate_catalog(catalog, paths):
    ids = [s.get('id') for s in catalog['songs']]
    if len(ids) != len(set(ids)):
        raise StoreError('songs.json 에 중복된 곡 ID 가 있습니다.')
    for s in catalog['songs']:
        if not s.get('id') or not s.get('title'):
            raise StoreError('songs.json 항목에 id/title 이 없습니다.')


def load_stage(stage_dir):
    stage_dir = Path(stage_dir)
    manifest = json.loads((stage_dir / 'stage.json').read_text(encoding='utf-8'))
    charts = {d: json.loads((stage_dir / 'charts' / f'{d}.json').read_text(encoding='utf-8')) for d in DIFFICULTIES}
    return manifest, charts


def verify_stage(stage_dir):
    stage_dir = Path(stage_dir)
    manifest, charts = load_stage(stage_dir)
    for name in ('video.mp4', 'cover.webp'):
        if not (stage_dir / name).is_file() or (stage_dir / name).stat().st_size == 0:
            raise StoreError(f'staging 파일이 없습니다: {name}')
    errors = []
    for d in DIFFICULTIES:
        errors += validate_chart(charts[d], manifest['durationMs'], music_start_ms=manifest['analysis']['musicStartMs'])
    set_errors, _ = validate_set(charts)
    if errors or set_errors:
        raise StoreError('채보 검증 실패: ' + '; '.join((errors + set_errors)[:5]))
    return manifest, charts


def commit_stage(stage_dir, paths=None, staging=STAGING):
    """staging → 실제 사이트에 등록. 성공하면 songs.json 항목을, 실패하면 StoreError."""
    paths = paths or Paths()
    stage_dir = Path(stage_dir)
    manifest, charts = verify_stage(stage_dir)
    created = []
    with catalog_lock(paths):
        catalog = load_catalog(paths)
        song_id = manifest['songId']
        others = taken_ids(paths, staging, include_staging=False)
        if song_id in others:  # staging 이후 다른 곡이 같은 ID 를 가져감
            song_id = allocate_id(paths, staging, include_staging=False)
        try:
            pairs = [(stage_dir / 'video.mp4', paths.video(song_id)), (stage_dir / 'cover.webp', paths.cover(song_id))]
            for src, dst in pairs:
                dst.parent.mkdir(parents=True, exist_ok=True)
                tmp = dst.with_name(dst.name + '.tmp')
                created.append(tmp)
                shutil.copyfile(src, tmp)
                os.replace(tmp, dst)
                created.append(dst)
            for d in DIFFICULTIES:
                chart = {**charts[d], 'songId': song_id}
                dst = paths.chart(song_id, d)
                created.append(dst)
                write_chart(dst, chart)
            entry = song_entry(song_id, manifest)
            new_catalog = {**catalog, 'songs': [*catalog['songs'], entry]}
            validate_catalog(new_catalog, paths)
            write_json_atomic(paths.songs_json, new_catalog)
        except Exception as exc:
            for p in created:
                with contextlib.suppress(OSError):
                    Path(p).unlink()
            raise StoreError(f'곡 등록에 실패했습니다: {exc}') from exc
    shutil.rmtree(stage_dir, ignore_errors=True)
    return entry


def discard_stage(stage_dir):
    shutil.rmtree(stage_dir, ignore_errors=True)


def remove_song(song_id, paths=None):
    """songs.json 에서 먼저 빼고 (사이트에서 즉시 사라짐) 파일을 지운다."""
    paths = paths or Paths()
    with catalog_lock(paths):
        catalog = load_catalog(paths)
        if not any(s.get('id') == song_id for s in catalog['songs']):
            raise StoreError(f'등록되지 않은 곡입니다: {song_id}')
        write_json_atomic(paths.songs_json, {**catalog, 'songs': [s for s in catalog['songs'] if s.get('id') != song_id]})
    charts = [paths.chart(song_id, d, n) for d in DIFFICULTIES for n in (4, 6, 8)]
    for p in [paths.video(song_id), paths.cover(song_id), *charts]:
        with contextlib.suppress(FileNotFoundError):
            p.unlink()
