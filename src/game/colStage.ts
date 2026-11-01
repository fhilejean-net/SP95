export interface StagePoint { x: number; z: number; s: number; width: number }

/** Passage dans le sens de la route, uniquement à proximité de sa largeur. */
function crossing(a: StagePoint, b: StagePoint, previous: {x: number; z: number}, current: {x: number; z: number}): boolean {
  const dx=b.x-a.x, dz=b.z-a.z, length=Math.hypot(dx,dz);
  if(length<0.001) return false;
  const fx=dx/length, fz=dz/length;
  const old=(previous.x-a.x)*fx+(previous.z-a.z)*fz;
  const now=(current.x-a.x)*fx+(current.z-a.z)*fz;
  const lateral=Math.abs((current.x-a.x)*-fz+(current.z-a.z)*fx);
  return old<0 && now>=0 && lateral<=a.width/2+2 && now-old<50 && Math.hypot(current.x-previous.x,current.z-previous.z)<50;
}

export class ColStage {
  elapsed = 0;
  state: 'waiting' | 'running' | 'finished' = 'waiting';
  private previous: {x:number;z:number} | null = null;
  private readonly start: StagePoint;
  private readonly startNext: StagePoint;
  private readonly finish: StagePoint;
  private readonly finishNext: StagePoint;

  constructor(samples: StagePoint[], endS: number) {
    if (samples.length < 3) throw new Error('Tracé du col incomplet');
    this.start=samples[0]; this.startNext=samples[1];
    const found=samples.findIndex((p)=>p.s>=endS);
    const i=found<0 ? samples.length-2 : Math.min(samples.length-2, found);
    this.finish=samples[i]; this.finishNext=samples[i+1];
  }

  reset(): void { this.elapsed=0; this.state='waiting'; this.previous=null; }

  update(dt:number,x:number,z:number): 'start' | 'finish' | null {
    const point={x,z}; const previous=this.previous; this.previous=point;
    if(this.state==='running') this.elapsed+=dt;
    if(!previous) return null;
    if(this.state==='waiting' && crossing(this.start,this.startNext,previous,point)) {
      this.state='running'; this.elapsed=0; return 'start';
    }
    if(this.state==='running' && crossing(this.finish,this.finishNext,previous,point)) {
      this.state='finished'; return 'finish';
    }
    return null;
  }
}
