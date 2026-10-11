"""Pure temporal hysteresis; shared evidence rule, no pose inference."""
from collections import deque
from app.segments.detection import evidence


class LiveState:
    def __init__(self,config):
        self.config=config;self.state='IDLE';self.hits=deque();self.last_hit=None;self.current=None
        self.segments=[];self.transitions=[];self.confidence=0.0;self.last_timestamp=-1
    def change(self,state,t):
        if self.state!=state:
            self.state=state;self.transitions.append({'state':state,'timestamp':t})
            self.transitions=self.transitions[-200:]
    def tick(self,t,signals):
        if t<self.last_timestamp:raise ValueError('Live timestamps must be monotonic')
        self.last_timestamp=t
        confidence,accepted=evidence(signals,self.config['threshold']);self.confidence=confidence
        if self.state=='IDLE':self.change('WATCHING',t)
        if self.current is not None:
            if accepted:
                self.last_hit=t;self.current['confidence']=min(self.current['confidence'],confidence)
                self.current['signals']=sorted(set(self.current['signals'])|{k for k,v in signals.items() if v>0})
                self.current['last_signal']=t
            elif t-self.last_hit>=self.config['ending_seconds']:
                self.change('BASEBALL_ENDING',t)
                return 'close'
            return 'analyze' if accepted else None
        if accepted:
            if self.hits and t-self.hits[-1]>self.config['sample_interval']*2:
                self.hits.clear()
            self.hits.append(t)
            while self.hits and self.hits[0]<t-self.config['confirmation_seconds']-self.config['sample_interval']:
                self.hits.popleft()
            self.change('BASEBALL_CANDIDATE',t)
            if len(self.hits)>=self.config['minimum_hits'] and t-self.hits[0]>=self.config['confirmation_seconds']-self.config['sample_interval']*.1:
                self.current={'start':self.hits[0],'last_signal':t,'confidence':confidence,'signals':sorted(k for k,v in signals.items() if v>0),
                              'estimated':True,'roles':[],'analyses':[],'review_required':True}
                self.last_hit=t;self.hits.clear();self.change('BASEBALL_ANALYZING',t)
                return 'analyze'
        else:
            self.hits.clear();self.change('WATCHING',t)
        return None
    def finish(self,t):
        if self.current is None:return
        self.change('BASEBALL_ENDING',t)
        self.change('REPORT_GENERATING',t)
        self.current['end']=min(t,self.last_hit+self.config['sample_interval'])
        self.current['duration']=max(0,self.current['end']-self.current['start'])
        self.segments.append(self.current);self.current=None;self.hits.clear()
        self.change('WATCHING',t)
