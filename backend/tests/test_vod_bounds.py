"""VOD time hints: same bounds rule (0 <= start < end <= duration), cause-specific messages."""
import pytest
from app.segments.vod import discovery_plan

DURATION = 11.046615  # wony-pitcher-001.mp4


@pytest.mark.parametrize('kwargs,code', [
    ({'start': '1', 'end': '20'}, 'vod_end_after_duration'),
    ({'start': '5', 'end': '3'}, 'vod_start_not_before_end'),
    ({'start': '5', 'end': '5'}, 'vod_start_not_before_end'),
    ({'center_time': '30'}, 'vod_center_outside'),
    ({'center_time': '11.046615'}, 'vod_center_outside'),
    ({'start': '1', 'end': '5', 'center_time': '3'}, 'vod_hint_conflict'),
    ({'start': '1'}, 'vod_range_missing'),
    ({'start': '1', 'end': '00:00:99'}, 'vod_time_format'),
    ({'start': 'abc', 'end': '5'}, 'vod_time_format'),
])
def test_rejections_name_the_cause(kwargs, code):
    with pytest.raises(ValueError) as error:
        discovery_plan(DURATION, 'approximate', **kwargs)
    assert str(error.value).startswith(f'[{code}]')


def test_seconds_and_hms_are_the_same_unit():
    by_seconds, _ = discovery_plan(DURATION, 'exact', start='1', end='11')
    by_hms, _ = discovery_plan(DURATION, 'exact', start='00:00:01', end='00:00:11')
    assert by_seconds == by_hms and (by_seconds['search_start'], by_seconds['search_end']) == (1, 11)


def test_end_equal_to_duration_is_still_allowed():
    plan, _ = discovery_plan(DURATION, 'approximate', start='1', end=str(DURATION), buffer_minutes=0)
    assert plan['search_end'] == DURATION


def test_center_only_plan():
    plan, _ = discovery_plan(DURATION, 'approximate', center_time='5', search_window_minutes=1)
    assert plan['search_start'] == 0 and plan['search_end'] == DURATION
