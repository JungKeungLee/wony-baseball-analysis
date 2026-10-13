"""등록된 곡 삭제: songs.json 에서 먼저 빼고(사이트에서 즉시 사라짐) 영상/cover/채보 파일을 지운다.

    python tools/remove_song.py wony-cover-02
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import song_store  # noqa: E402


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print('사용법: python tools/remove_song.py 곡ID', file=sys.stderr)
        return 2
    try:
        song_store.remove_song(argv[0])
    except song_store.StoreError as exc:
        print(f'실패: {exc}', file=sys.stderr)
        return 1
    print(f'삭제 완료: {argv[0]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
