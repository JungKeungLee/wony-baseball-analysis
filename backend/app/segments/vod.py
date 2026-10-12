from app.segments.detection import seconds as parse_seconds,manual_segments


def seconds(value,field):
    """Seconds (e.g. "20") or HH:MM:SS (e.g. "00:00:20"); same parser, field-specific error."""
    try:return parse_seconds(value)
    except (ValueError,TypeError) as exc:raise ValueError(f'[vod_time_format] {field} must be seconds or HH:MM:SS: {value!r}') from exc


def discovery_plan(duration,mode='auto',start=None,end=None,center_time=None,buffer_minutes=10,search_window_minutes=60,role='unknown'):
    if mode not in {'exact','approximate','auto'}:raise ValueError('Invalid VOD discovery mode')
    if mode=='auto':
        if any(v is not None for v in [start,end,center_time]):raise ValueError('AUTO does not accept time hints')
        return {'mode':mode,'search_start':0,'search_end':duration},None
    if center_time is not None:
        if mode=='exact' or start is not None or end is not None:raise ValueError('[vod_hint_conflict] Center time is only for approximate mode without start/end')
        center=seconds(center_time,'center_time')
        if center>=duration:raise ValueError(f'[vod_center_outside] Center {center:.3f}s is outside the video (duration {duration:.3f}s)')
        a=max(0,center-search_window_minutes*30);b=min(duration,center+search_window_minutes*30)
    else:
        if start is None or end is None:raise ValueError('[vod_range_missing] Start and end are required')
        a,b=seconds(start,'start'),seconds(end,'end')
        # Same rule as before (0 <= start < end <= duration); only the message names the failing part.
        if a>=b:raise ValueError(f'[vod_start_not_before_end] Start {a:.3f}s must be before end {b:.3f}s')
        if b>duration:raise ValueError(f'[vod_end_after_duration] End {b:.3f}s is after the video duration {duration:.3f}s')
        if a<0:raise ValueError('[vod_start_negative] Start must be 0 or later')
        if mode=='approximate':a=max(0,a-buffer_minutes*60);b=min(duration,b+buffer_minutes*60)
    selected=manual_segments([{'start':a,'end':b,'role':role}],duration) if mode=='exact' else None
    return {'mode':mode,'search_start':a,'search_end':b,'time_origin':'full_video_seconds'},selected
