"""이미 등록된 곡에 6키 / 8키 채보를 추가한다 (4키 채보는 그대로).

    python tools/add_lane_modes.py --song demo-beat --lanes 6,8

게임에서 재생하는 바로 그 MP4 를 다시 분석하므로 노트 시각은 4키 채보와 같고, 레인 배치만 레인 수에 맞게 새로 만든다
(4키 채보를 6/8키로 "변환"하지 않음). 결과:
  frontend-demo/songs/charts/{id}-{difficulty}-{n}k.json
  songs.json 의 해당 곡에 "laneModes": [4, 6, 8]  ← 게임 · 서버가 이 목록으로 선택 가능한 KEY 모드를 판단
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import audio_analyzer  # noqa: E402
import chart_generator  # noqa: E402
import media  # noqa: E402
import song_store  # noqa: E402
from chart_config import DIFFICULTIES, SUPPORTED_LANE_COUNTS  # noqa: E402


def add_lane_modes(song_id, lane_counts, paths=None, progress=print):
    paths = paths or song_store.Paths()
    lane_counts = sorted({int(n) for n in lane_counts} - {4})
    bad = [n for n in lane_counts if n not in SUPPORTED_LANE_COUNTS]
    if bad or not lane_counts:
        raise song_store.StoreError(f'추가할 레인 수는 6 또는 8 입니다: {bad or lane_counts}')
    song = next((s for s in song_store.load_catalog(paths)['songs'] if s.get('id') == song_id), None)
    if not song:
        raise song_store.StoreError(f'등록되지 않은 곡입니다: {song_id}')
    video = paths.video(song_id)
    if not video.is_file():
        raise song_store.StoreError(f'영상 파일이 없습니다: {video}')
    progress(f'{song_id}: 오디오 분석')
    info = media.probe(video)
    duration_ms = int(info['duration'] * 1000)
    samples = media.extract_audio(video, audio_analyzer.SR)
    analysis = audio_analyzer.analyze(samples, offset_ms=media.audio_offset_ms(info), duration_ms=duration_ms)
    del samples
    written = []
    for n in lane_counts:
        charts = {d: chart_generator.generate_chart(analysis, song_id, d, lane_count=n) for d in song.get('difficulties', DIFFICULTIES)}
        errors = [e for c in charts.values() for e in chart_generator.validate_chart(c, duration_ms, music_start_ms=analysis.music_start_ms)]
        if len(charts) == len(DIFFICULTIES):
            errors += chart_generator.validate_set(charts)[0]
        if errors:
            raise song_store.StoreError(f'{n}키 채보 검증 실패: ' + '; '.join(errors[:5]))
        for d, chart in charts.items():
            song_store.write_chart(paths.chart(song_id, d, n), chart)
            written.append(paths.chart(song_id, d, n).name)
        progress(f'{n}키: ' + ', '.join(f'{d.upper()} {len(c["notes"])}' for d, c in charts.items()))
    # 채보를 모두 쓴 뒤 마지막에 목록 갱신 (게임에 나타나는 시점)
    with song_store.catalog_lock(paths):
        catalog = song_store.load_catalog(paths)
        for s in catalog['songs']:
            if s.get('id') == song_id:
                s['laneModes'] = sorted({4, *(s.get('laneModes') or []), *lane_counts})
        song_store.write_json_atomic(paths.songs_json, catalog)
    return written


def main(argv=None):
    p = argparse.ArgumentParser(description='등록된 곡에 6키 / 8키 채보 추가')
    p.add_argument('--song', required=True)
    p.add_argument('--lanes', default='6,8', help='예: 6,8')
    args = p.parse_args(argv)
    try:
        files = add_lane_modes(args.song, args.lanes.split(','))
    except (song_store.StoreError, chart_generator.ChartError, media.MediaError, audio_analyzer.AnalysisError) as exc:
        print(f'실패: {exc}', file=sys.stderr)
        return 1
    print('완료:', ', '.join(files))
    return 0


if __name__ == '__main__':
    sys.exit(main())
