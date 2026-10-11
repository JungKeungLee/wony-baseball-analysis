import json
from uuid import uuid4
from .test_roles import client
from app.models.storage import data_dir


def result(role='batter',demo=False):
    return {'id':str(uuid4()),'role':role,'metrics':{},'analysis_date':'2026-10-12','sample_fps':10,
        'visualization':{'frame_count':20},'synthetic_demo':demo}


def save(r):
    (data_dir()/f"{r['id']}.json").write_text(json.dumps(r))


def test_reports_list_source_separation_single_and_not_found(client):
    real=result();demo=result(demo=True);save(real);save(demo)
    listing=client.get('/api/reports').json()
    assert listing['total']==1 and listing['items'][0]['id']==real['id']
    assert client.get('/api/reports?source=demo').json()['items'][0]['id']==demo['id']
    report=client.get('/api/reports/'+real['id']).json()
    assert report['entries'][0]['analysis']==real
    assert report['entries'][0]['source_url'] is None
    assert client.get('/api/reports/'+str(uuid4())).status_code==404
    assert client.get('/api/reports?source=all').status_code==422
    assert client.get('/api/reports?limit=101').status_code==422


def test_grouped_broadcast_multiple_roles_no_duplicate_records(client):
    one=result();two=result('defense');save(one);save(two)
    job_id=str(uuid4());folder=data_dir()/'broadcasts'/job_id;folder.mkdir(parents=True)
    manifest={'analyses':[{'analysis_id':one['id'],'start':100,'end':102},{'analysis_id':two['id'],'start':300,'end':302}],
        'baseball_segments':[{'start':100,'end':350}],'created_at':'2026-10-12T00:00:00+00:00'}
    (folder/'job.json').write_text(json.dumps(manifest));(folder/'source.upload').write_bytes(b'original')
    listing=client.get('/api/reports').json()
    assert listing['total']==1 and listing['items'][0]['roles']==['batter','defense']
    assert listing['items'][0]['analyzed_seconds']==4
    group=client.get('/api/reports/'+job_id).json()
    assert len(group['entries'])==2 and group['entries'][1]['start']==300
    assert client.get(group['entries'][0]['source_url']).content==b'original'
    assert client.get('/api/analysis/'+one['id']).json()==one
    assert client.get('/demo/analysis/'+job_id).status_code==200
    assert '통합 야구 스카우팅 리포트' in client.get('/demo/analysis/'+job_id).text


def test_routes_and_legacy_redirect(client):
    for page in ['/demo/','/demo/broadcast/','/demo/analyses/']:
        response=client.get(page)
        assert response.status_code==200
        assert '대시보드' in response.text and '분석 기록' in response.text
    r=client.get('/demo/live/',follow_redirects=False)
    assert r.status_code==307 and r.headers['location']=='/demo/broadcast/?tab=live'
    assert client.get('/demo/analysis/not-uuid').status_code==422
