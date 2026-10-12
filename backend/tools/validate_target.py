"""Bounded CLI for a user-confirmed WONY ROI; outputs remain validation-only."""
import argparse,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.validation.target import TargetSelection
from app.validation.runner import validate_clip
from app.validation.records import save_source_name

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('video',type=Path);parser.add_argument('--selection',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--hud-config',type=Path,help='Optional manually labeled native HUD crop boxes')
    parser.add_argument('--batter-review',type=Path,help='Optional manual swing review windows; not detected event timings')
    args=parser.parse_args()
    selection=TargetSelection.model_validate(json.loads(args.selection.read_text(encoding='utf-8')))
    if not selection.confirmed_by_user:parser.error('Human confirmation of the selected WONY target is required')
    hud=json.loads(args.hud_config.read_text(encoding='utf-8')) if args.hud_config else None
    review=json.loads(args.batter_review.read_text(encoding='utf-8')) if args.batter_review else None
    result=validate_clip(args.video,selection,args.output,hud_regions=hud,batter_review=review)
    save_source_name(args.output/result['id'],args.video.name)
    print(json.dumps({'id':result['id'],'summary':result['validation_summary'],
        'tracking_status':result['target_tracking']['status'],'lost_at':result['target_tracking']['lost_at'],
        'auto_role':result.get('automatic_role_estimate'),'role_input':result['role_input'],
        'game_hud_speed':result['game_hud_speed'],'result':str(args.output/result['id']/'analysis.json')},ensure_ascii=False,indent=2))
