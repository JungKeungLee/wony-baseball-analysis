"""Experimental bat/effect sequence validation; local ignored artifacts only."""
import argparse,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.validation.bat_sequence import BatConfig,validate_bat_sequence
if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('video',type=Path);parser.add_argument('--config',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path);parser.add_argument('--target-report',type=Path)
    args=parser.parse_args();config=BatConfig.model_validate(json.loads(args.config.read_text(encoding='utf-8')))
    result,folder=validate_bat_sequence(args.video,config,args.output,args.target_report)
    print(json.dumps({'id':result['id'],'sha256':result['source_sha256'],'summary':result['summary'],'result':str(folder/'analysis.json')},indent=2))
