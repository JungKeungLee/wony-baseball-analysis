"""등록된 곡의 채보 끝에 곡 끝부분 박을 이어 붙인다 (기존 노트는 그대로).

    python tools/extend_outro.py --song wony-cover-01 --lanes 4

분석이 음악 끝으로 본 시점(music_end) 뒤에도 박이 또렷하게 이어지는 곡에서, 그 박(outro_beats)만 난이도 규칙대로 더한다.
기존 노트의 time · lane 은 바꾸지 않는다 (앞부분 그대로, 끝에만 추가). 이미 이어 붙인 채보에 다시 실행하면 더할 노트가 없다.
4키 채보를 늘리면 songs.json 의 noteCounts 도 맞춘다.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import audio_analyzer  # noqa: E402
import chart_generator  # noqa: E402
import json  # noqa: E402
import media  # noqa: E402
import song_store  # noqa: E402
from chart_config import DIFFICULTIES  # noqa: E402


def extend_outro(song_id, lane_counts=(4,), paths=None, progress=print):
    paths = paths or song_store.Paths()
    song = next((s for s in song_store.load_catalog(paths)['songs'] if s.get('id') == song_id), None)
    if not song:
        raise song_store.StoreError(f'등록되지 않은 곡입니다: {song_id}')
    video = paths.video(song_id)
    info = media.probe(video)
    duration_ms = int(info['duration'] * 1000)
    debug = {}
    analysis = audio_analyzer.analyze(media.extract_audio(video, audio_analyzer.SR), offset_ms=media.audio_offset_ms(info),
                                      duration_ms=duration_ms, debug=debug)
    outro = chart_generator.outro_beats(analysis, debug)
    if not outro:
        progress('곡 끝부분에 더할 박이 없습니다.')
        return {}
    progress(f'곡 끝 박 {len(outro)}개 ({outro[0].time}~{outro[-1].time}ms)')
    result = {}
    for n in lane_counts:
        charts, added = {}, {}
        for d in song['difficulties']:
            chart = json.loads(paths.chart(song_id, d, n).read_text(encoding='utf-8'))
            charts[d], added[d] = chart_generator.extend_with_outro(chart, analysis, outro, d, seed=f'{song_id}:{d}:{n}k')
        errors = [e for c in charts.values() for e in chart_generator.validate_chart(c, duration_ms, music_start_ms=analysis.music_start_ms)]
        if len(charts) == len(DIFFICULTIES):
            errors += chart_generator.validate_set(charts)[0]
        if errors:
            raise song_store.StoreError(f'{n}키 채보 검증 실패: ' + '; '.join(errors[:5]))
        for d, chart in charts.items():
            if added[d]:
                song_store.write_chart(paths.chart(song_id, d, n), chart)
        result[n] = {d: len(added[d]) for d in charts}
        progress(f'{n}키 추가: ' + ', '.join(f'{d.upper()} +{len(added[d])} → {len(charts[d]["notes"])}' for d in charts))
        if n == 4:  # 곡 목록의 노트 수 (곡 선택 · 미리보기 표시)
            with song_store.catalog_lock(paths):
                catalog = song_store.load_catalog(paths)
                for s in catalog['songs']:
                    if s.get('id') == song_id:
                        s['noteCounts'] = {d: len(charts[d]['notes']) for d in charts}
                song_store.write_json_atomic(paths.songs_json, catalog)
    return result


def main(argv=None):
    p = argparse.ArgumentParser(description='채보 끝에 곡 끝부분 박 이어 붙이기 (기존 노트 그대로)')
    p.add_argument('--song', required=True)
    p.add_argument('--lanes', default='4', help='예: 4 또는 4,6,8')
    args = p.parse_args(argv)
    try:
        extend_outro(args.song, [int(x) for x in args.lanes.split(',')])
    except (song_store.StoreError, chart_generator.ChartError, media.MediaError, audio_analyzer.AnalysisError) as exc:
        print(f'실패: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
