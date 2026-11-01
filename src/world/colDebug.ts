import type { ColPoint } from './mollendruz.ts';

export function createColDebug(samples: ColPoint[], bounds: number[], h0: number) {
  const root=document.createElement('div'); root.className='col-debug';
  const map=document.createElement('canvas'); map.width=430; map.height=290;
  const profile=document.createElement('canvas'); profile.width=430; profile.height=110;
  const status=document.createElement('div');
  root.append(map,profile,status); document.body.append(root);
  const ctx=map.getContext('2d')!, chart=profile.getContext('2d')!;
  const [x0,z0,x1,z1]=bounds;
  const mapX=(x:number)=>(x-x0)/(x1-x0)*map.width, mapZ=(z:number)=>(z-z0)/(z1-z0)*map.height;
  const image=new Image(); image.src=`${import.meta.env.BASE_URL}data/mollendruz/hillshade.webp`;
  let loaded=false; image.onload=()=>{loaded=true;};
  const minY=Math.min(...samples.map(p=>p.y)), maxY=Math.max(...samples.map(p=>p.y));
  const lastS=samples[samples.length-1].s;
  const bends:number[]=[];
  for(let i=2;i<samples.length-2;i++) {
    const a=samples[i-2],b=samples[i],c=samples[i+2];
    const v1={x:b.x-a.x,z:b.z-a.z},v2={x:c.x-b.x,z:c.z-b.z};
    const len1=Math.hypot(v1.x,v1.z),len2=Math.hypot(v2.x,v2.z);
    const angle=Math.atan2(v1.x*v2.z-v1.z*v2.x,v1.x*v2.x+v1.z*v2.z);
    if(Math.abs(angle)/((len1+len2)/2)>1/30 && (!bends.length || b.s-samples[bends[bends.length-1]].s>35)) bends.push(i);
  }
  function update(x:number,z:number,s:number,gradient:number,fps:number,draws:number) {
    ctx.fillStyle='#111';ctx.fillRect(0,0,map.width,map.height);
    if(loaded) ctx.drawImage(image,0,0,map.width,map.height);
    ctx.strokeStyle='#ffb244';ctx.lineWidth=2;ctx.beginPath();
    samples.forEach((p,i)=>i?ctx.lineTo(mapX(p.x),mapZ(p.z)):ctx.moveTo(mapX(p.x),mapZ(p.z)));ctx.stroke();
    ctx.fillStyle='#ff3939'; for(const i of bends){const p=samples[i];ctx.beginPath();ctx.arc(mapX(p.x),mapZ(p.z),3,0,Math.PI*2);ctx.fill();}
    ctx.fillStyle='#52e4ff';ctx.beginPath();ctx.arc(mapX(x),mapZ(z),4,0,Math.PI*2);ctx.fill();
    chart.fillStyle='#17202a';chart.fillRect(0,0,profile.width,profile.height);
    chart.strokeStyle='#a9d58d';chart.lineWidth=2;chart.beginPath();
    samples.forEach((p,i)=>{const px=p.s/lastS*profile.width,py=profile.height-8-(p.y-minY)/(maxY-minY||1)*(profile.height-16);i?chart.lineTo(px,py):chart.moveTo(px,py);});chart.stroke();
    chart.strokeStyle='#52e4ff';chart.beginPath();chart.moveTo(s/lastS*profile.width,0);chart.lineTo(s/lastS*profile.width,profile.height);chart.stroke();
    status.textContent=`${Math.round(s)} m · altitude ${Math.round(h0+(samples.find(p=>p.s>=s)?.y ?? 0))} m · pente ${gradient.toFixed(1)} % · ${fps} FPS · ${draws} draw calls`;
  }
  return { update };
}
