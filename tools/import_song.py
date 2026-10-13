"""MP4 하나 + 곡 제목 → 곡 자동 생성 (로컬 전용 도구).

    python tools/import_song.py --video "C:/path/my-song.mp4" --title "여름이야 부탁해"

옵션
    --artist WONY        (기본 WONY)
    --cover image.png    cover 를 직접 지정 (없으면 영상에서 자동 추출)
    --id wony-cover-07   곡 ID 직접 지정 (없으면 wony-cover-NN 자동 발급)
    --stage-only         등록하지 않고 미리보기용 staging 까지만 (tools/admin_server.py 에서 확인 후 저장)

자동 처리: 영상 확인 → 웹용 MP4 준비(원본 timeline 유지) → cover → 오디오 분석
          → EASY/NORMAL/HARD/HELL 채보 → 검증 → (staging) → songs.json 등록
원본 MP4 는 읽기만 한다. 실패하면 staging 폴더째 지워서 불완전한 데이터를 남기지 않는다.
"""
import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import audio_analyzer  # noqa: E402
import chart_generator  # noqa: E402
import cover_generator  # noqa: E402
import media  # noqa: E402
import song_store  # noqa: E402
from chart_config import DEFAULT_LANE_COUNT, DIFFICULTIES  # noqa: E402


class ImportFailed(RuntimeError):
    """사용자에게 그대로 보여줄 메시지를 담는다."""


STEPS = ['영상 정보 확인', '영상 저장 준비', '대표 이미지 추출', '오디오 분석', '채보 생성', '검증']


def stage_song(video, title, *, artist='WONY', cover=None, song_id=None, paths=None, staging=song_store.STAGING,
               progress=None, lane_count=DEFAULT_LANE_COUNT):
    """미리보기용 staging 폴더를 만든다. 반환: (stage_dir, manifest).
    lane_count: 채보 레인 수 (기본 4. 6/8 은 향후 모드 확장용, 게임 UI 는 아직 4키만)."""
    paths = paths or song_store.Paths()
    say = progress or (lambda step, msg='': None)
    video = Path(video)
    title = (title or '').strip()
    if not title:
        raise ImportFailed('곡 제목을 입력해주세요.')
    if not video.is_file():
        raise ImportFailed(f'영상 파일을 찾을 수 없습니다: {video}')
    if cover and not Path(cover).is_file():
        raise ImportFailed(f'cover 이미지를 찾을 수 없습니다: {cover}')

    Path(staging).mkdir(parents=True, exist_ok=True)
    try:
        song_id = song_store.check_custom_id(song_id, paths, staging) if song_id else song_store.allocate_id(paths, staging)
    except song_store.StoreError as exc:
        raise ImportFailed(str(exc)) from exc
    stage = song_store.new_stage_dir(staging)
    # 다른 작업이 같은 번호를 쓰지 않도록 ID 를 먼저 예약
    song_store.write_json_atomic(stage / 'stage.json', {'songId': song_id, 'status': 'working'})
    step = STEPS[0]
    try:
        say(step)
        try:
            info = media.probe(video)
        except media.MediaError as exc:
            raise ImportFailed(f'영상 정보를 읽지 못했습니다: {exc}') from exc
        if not info['has_video']:
            raise ImportFailed('영상 트랙이 없는 파일입니다. 영상 + 음악이 들어 있는 MP4 를 선택해주세요.')
        if not info['has_audio']:
            raise ImportFailed('오디오 트랙이 없는 영상입니다. 음악이 들어 있는 MP4 를 선택해주세요.')
        if info['duration'] < 10:
            raise ImportFailed('영상이 너무 짧습니다 (10초 이상 필요).')

        step = STEPS[1]
        say(step, '재인코딩 없이 복사' if info['vcodec'] == 'h264' and info['acodec'] in ('aac', 'mp3') else 'H.264/AAC 로 변환 중')
        staged_video = stage / 'video.mp4'
        try:
            media.prepare_web_video(video, staged_video, info)
            vinfo = media.probe(staged_video)
        except media.MediaError as exc:
            raise ImportFailed(f'영상을 저장하지 못했습니다: {exc}') from exc
        duration_ms = int(vinfo['duration'] * 1000)

        step = STEPS[2]
        say(step)
        try:
            cover_info = cover_generator.make_cover(staged_video, vinfo['duration'], stage / 'cover.webp', cover)
        except (cover_generator.CoverError, media.MediaError) as exc:
            raise ImportFailed(f'대표 이미지 생성에 실패했습니다: {exc}') from exc

        step = STEPS[3]
        say(step, 'beat / onset / 강세 / 에너지')
        try:
            # 게임에서 재생할 바로 그 파일을 분석한다 → video.currentTime 과 같은 timeline
            samples = media.extract_audio(staged_video, audio_analyzer.SR)
            analysis = audio_analyzer.analyze(samples, offset_ms=media.audio_offset_ms(vinfo), duration_ms=duration_ms)
            del samples
        except (audio_analyzer.AnalysisError, media.MediaError) as exc:
            raise ImportFailed(f'음악 분석에 실패했습니다: {exc}') from exc
        except MemoryError as exc:
            raise ImportFailed('음악 분석에 실패했습니다: 메모리가 부족합니다.') from exc

        step = STEPS[4]
        charts = {}
        for d in DIFFICULTIES:
            say(step, d.upper())
            try:
                charts[d] = chart_generator.generate_chart(analysis, song_id, d, lane_count=lane_count)
            except chart_generator.ChartError as exc:
                raise ImportFailed(f'채보 생성에 실패했습니다: {exc}') from exc

        step = STEPS[5]
        say(step)
        errors = []
        for d in DIFFICULTIES:
            errors += chart_generator.validate_chart(charts[d], duration_ms, music_start_ms=analysis.music_start_ms)
        set_errors, warnings = chart_generator.validate_set(charts)
        if errors or set_errors:
            raise ImportFailed('채보 검증에 실패했습니다: ' + '; '.join((errors + set_errors)[:5]))
        for d in DIFFICULTIES:
            song_store.write_chart(stage / 'charts' / f'{d}.json', charts[d])

        manifest = {
            'stageId': stage.name,
            'songId': song_id,
            'title': title,
            'artist': (artist or 'WONY').strip() or 'WONY',
            'status': 'ready',
            'createdAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'source': video.name,
            'durationMs': duration_ms,
            'video': {'codec': vinfo['vcodec'], 'audio': vinfo['acodec'], 'width': vinfo['width'], 'height': vinfo['height'],
                      'transcoded': not (info['vcodec'] == 'h264' and info['acodec'] in ('aac', 'mp3'))},
            'cover': cover_info,
            'analysis': analysis.summary(),
            'noteCounts': {d: len(charts[d]['notes']) for d in DIFFICULTIES},
            'chordCounts': {d: len(charts[d]['notes']) - len({n['time'] for n in charts[d]['notes']}) for d in DIFFICULTIES},
            'warnings': warnings,
        }
        # 미리보기 화면(tools/admin_server.py)이 읽는 곡 항목
        base = f'/staging/{stage.name}'
        song_store.write_json_atomic(stage / 'song.json', {
            'id': song_id, 'title': manifest['title'], 'artist': manifest['artist'], 'preview': True,
            'video': f'{base}/video.mp4', 'cover': f'{base}/cover.webp', 'difficulties': list(DIFFICULTIES),
            'charts': {d: f'{base}/charts/{d}.json' for d in DIFFICULTIES}, 'durationMs': duration_ms,
            'noteCounts': manifest['noteCounts'], 'bpm': manifest['analysis']['bpm'],
        })
        song_store.write_json_atomic(stage / 'stage.json', manifest)
        return stage, manifest
    except ImportFailed:
        shutil.rmtree(stage, ignore_errors=True)  # 임시 cover/영상/채보 모두 정리
        raise
    except Exception as exc:  # 예상 못 한 오류도 같은 방식으로 정리
        shutil.rmtree(stage, ignore_errors=True)
        raise ImportFailed(f'{step} 단계에서 실패했습니다: {type(exc).__name__}: {exc}') from exc


def import_song(video, title, **kwargs):
    """staging 후 바로 등록 (CLI 기본 동작)."""
    paths = kwargs.pop('paths', None) or song_store.Paths()
    staging = kwargs.get('staging', song_store.STAGING)
    stage, manifest = stage_song(video, title, paths=paths, **kwargs)
    try:
        entry = song_store.commit_stage(stage, paths, staging)
    except song_store.StoreError as exc:
        song_store.discard_stage(stage)
        raise ImportFailed(str(exc)) from exc
    return entry, manifest


def _print_summary(manifest):
    a = manifest['analysis']
    print(f"  곡 ID       {manifest['songId']}")
    print(f"  제목        {manifest['title']} / {manifest['artist']}")
    print(f"  길이        {manifest['durationMs'] / 1000:.1f}s   BPM {a['bpm']}   음악 구간 {a['musicStartMs']}~{a['musicEndMs']}ms")
    print('  노트 수     ' + '  '.join(f"{d.upper()} {manifest['noteCounts'][d]}" for d in DIFFICULTIES))
    for w in manifest.get('warnings', []):
        print(f'  ! {w}')


def main(argv=None):
    p = argparse.ArgumentParser(description='MP4 + 곡 제목 → WONY RHYTHM 곡 자동 생성')
    p.add_argument('--video', required=True)
    p.add_argument('--title', required=True)
    p.add_argument('--artist', default='WONY')
    p.add_argument('--cover')
    p.add_argument('--id', dest='song_id')
    p.add_argument('--stage-only', action='store_true', help='등록하지 않고 미리보기용 staging 만 만든다')
    args = p.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):  # Windows 콘솔에서도 한글이 깨지지 않게
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')

    def progress(step, msg=''):
        print(f'· {step}' + (f' ({msg})' if msg else ''), flush=True)

    kwargs = dict(artist=args.artist, cover=args.cover, song_id=args.song_id, progress=progress)
    try:
        if args.stage_only:
            stage, manifest = stage_song(args.video, args.title, **kwargs)
            print('\n미리보기 준비 완료 (아직 등록 안 됨)')
            _print_summary(manifest)
            print(f'\n  python tools/admin_server.py  →  http://127.0.0.1:8001/  에서 미리보기 후 저장하세요.')
            print(f'  staging: {stage}')
        else:
            entry, manifest = import_song(args.video, args.title, **kwargs)
            print('\n등록 완료')
            _print_summary({**manifest, 'songId': entry['id']})
            print(f"\n  플레이: /game?song={entry['id']}")
    except ImportFailed as exc:
        print(f'\n실패: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
