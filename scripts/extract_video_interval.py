#!/usr/bin/env python3
"""Extract an explicit interval for denser manual review, retaining times and SHA256."""
import argparse,json
from pathlib import Path
import cv2,numpy as np
from PIL import Image,ImageDraw
from assess_liver_videos import frame_at,digest,probe
p=argparse.ArgumentParser(description=__doc__);p.add_argument('video',type=Path);p.add_argument('--start',type=float,required=True);p.add_argument('--end',type=float,required=True);p.add_argument('--count',type=int,default=16);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
meta=probe(a.video)
if not 0<=a.start<a.end<meta['duration_s'] or not 2<=a.count<=100:raise ValueError('Require valid start/end within video and count2..100')
a.output.mkdir(parents=True,exist_ok=True);times=np.linspace(a.start,a.end,a.count);sheet=Image.new('RGB',(1280,45+264*((a.count+2)//3)),'#101820');draw=ImageDraw.Draw(sheet)
draw.text((10,10),f'{a.video.name} | explicit {a.start}–{a.end}s interval | {a.count} frames',fill='white')
for i,t in enumerate(times):
 f=frame_at(a.video,float(t));cv2.imwrite(str(a.output/f'frame-{i:02d}.jpg'),f);im=Image.fromarray(cv2.cvtColor(f,cv2.COLOR_BGR2RGB));im.thumbnail((416,232));x=(i%3)*426;y=45+(i//3)*264;sheet.paste(im,(x,y));draw.text((x+5,y+236),f'{t:.3f}s',fill='white')
sheet.save(a.output/'contact-sheet.jpg',quality=93);(a.output/'interval.json').write_text(json.dumps({'path':str(a.video),'sha256':digest(a.video),'times_s':times.tolist(),'status':'EXTRACTED_PENDING_VISUAL_REVIEW'},indent=2)+'\n')
