from app.segments.detection import seconds,manual_segments


def discovery_plan(duration,mode='auto',start=None,end=None,center_time=None,buffer_minutes=10,search_window_minutes=60,role='unknown'):
    if mode not in {'exact','approximate','auto'}:raise ValueError('Invalid VOD discovery mode')
    if mode=='auto':
        if any(v is not None for v in [start,end,center_time]):raise ValueError('AUTO does not accept time hints')
        return {'mode':mode,'search_start':0,'search_end':duration},None
    if center_time is not None:
        if mode=='exact' or start is not None or end is not None:raise ValueError('Center time is only for approximate mode without start/end')
        center=seconds(center_time)
        if center>=duration:raise ValueError('Center time outside video')
        a=max(0,center-search_window_minutes*30);b=min(duration,center+search_window_minutes*30)
    else:
        if start is None or end is None:raise ValueError('Start and end are required')
        a,b=seconds(start),seconds(end)
        if not 0<=a<b<=duration:raise ValueError('Invalid VOD bounds')
        if mode=='approximate':a=max(0,a-buffer_minutes*60);b=min(duration,b+buffer_minutes*60)
    selected=manual_segments([{'start':a,'end':b,'role':role}],duration) if mode=='exact' else None
    return {'mode':mode,'search_start':a,'search_end':b,'time_origin':'full_video_seconds'},selected
