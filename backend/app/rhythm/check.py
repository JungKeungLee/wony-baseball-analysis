"""온라인 기록 연결 확인 (배포 후 1번): 환경변수 · Supabase 서명 함수 연결을 확인합니다. DB 에 아무것도 쓰지 않습니다.

    cd backend && python -m app.rhythm.check          (로컬: 저장소 루트 .env 사용)
    Render: Shell 탭에서  cd backend && python -m app.rhythm.check

값(비밀값 · 키)은 출력하지 않고 "있음/없음 · 길이"만 보여줍니다.
"""
import sys
import uuid

from app.rhythm.config import MIN_SECRET, load_config, load_local_env_file
from app.rhythm.supabase import DbError, RhythmDb


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    load_local_env_file()
    c = load_config()
    rows = [
        ('RHYTHM_LINK_SECRET', len(c.link_secret) >= MIN_SECRET, f'{len(c.link_secret)}자' if c.link_secret else '없음'),
        ('RHYTHM_DB_SECRET', len(c.db_secret) >= MIN_SECRET, f'{len(c.db_secret)}자' if c.db_secret else '없음'),
        ('SUPABASE_URL', bool(c.supabase_url), c.supabase_url or '없음/잘못됨 (https 주소)'),
        ('SUPABASE_PUBLISHABLE_KEY', bool(c.publishable_key), '있음' if c.publishable_key else '없음 (sb_secret_ 키는 사용 불가)'),
        ('WONY_PHONE_URL (선택)', True, c.phone_url or '없음'),
    ]
    for name, ok, detail in rows:
        print(f"{'OK ' if ok else 'NG '} {name}: {detail}")
    if not c.online_enabled:
        print('\n온라인 기능 꺼짐: 위 NG 항목을 채우세요. (게임 · 로컬 기록은 정상 동작)')
        return 1
    probe = str(uuid.uuid4())   # 존재하지 않는 회원: 조회만, 데이터 변경 없음
    try:
        # 랭킹 조회 = 서명 · 시간 · 함수 권한 확인 (001~005)
        RhythmDb(c).ranking(probe, 'connection-check', 'easy', 4, 1)
    except DbError as exc:
        hint = {
            'misconfigured': 'RHYTHM_DB_SECRET 이 Supabase(005 SQL) 값과 다르거나, SQL 001~006 이 아직 적용되지 않았거나, 공개 키가 틀립니다.',
            'unavailable': 'Supabase 에 연결하지 못했습니다 (주소 · 네트워크 확인).',
            'rejected': 'SQL 함수가 예상과 다릅니다. verify_rhythm.sql 결과를 확인하세요.',
        }.get(exc.kind, '')
        print(f'\nNG  Supabase 서명 함수 호출 실패 ({exc.kind}). {hint}')
        return 1
    print('\nOK  Supabase 서명 함수 연결 (rhythm_get_ranking_signed)')
    # 006 (츄르 지갑) · 007 (내 기록) 함수도 있는지: 없으면 저장 · 츄르 · 최고 기록 화면이 실패
    missing = []
    for name, call in [('006 rhythm_get_wallet_signed', lambda: RhythmDb(c).wallet(probe)),
                       ('007 rhythm_get_my_records_signed', lambda: RhythmDb(c).my_records(probe))]:
        try:
            call()
            print(f'OK  {name}')
        except DbError as exc:
            missing.append(name)
            print(f'NG  {name} ({exc.kind}) → supabase/sql 의 해당 SQL 을 적용하세요')
    print('참고: 008 (배속 4x · 6x 저장)은 verify_rhythm.sql 의 "008 note_speed" 줄로 확인하세요.')
    if missing:
        return 1
    print('\nOK  온라인 기록 · 랭킹 · 츄르 준비 완료')
    return 0


if __name__ == '__main__':
    sys.exit(main())
