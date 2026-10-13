"""저작권 없는 테스트용 데모곡(합성 영상+음악)을 만들어 자동 생성 파이프라인으로 등록한다.

    python tools/make_demo_song.py

곡 ID 는 demo-beat 로 고정 (실제 곡 wony-cover-01, 02 … 번호를 차지하지 않음).
필요 없어지면: python tools/remove_song.py demo-beat
"""
import sys
import tempfile
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parent / 'tests')]

import import_song  # noqa: E402
import synth_media  # noqa: E402


def main():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        synth_media.song_wav(tmp / 'demo.wav', intro_silence=2.0, talk_until=4.0, music_end=40.0, total=42.0, bpm=124, seed=7)
        synth_media.make_mp4(tmp / 'demo.mp4', tmp / 'demo.wav', total=42.0, fade_in=2.0, small=True)
        entry, manifest = import_song.import_song(tmp / 'demo.mp4', '테스트 비트', artist='WONY RHYTHM', song_id='demo-beat')
    print('등록 완료:', entry['id'], manifest['noteCounts'], manifest['analysis'])


if __name__ == '__main__':
    main()
