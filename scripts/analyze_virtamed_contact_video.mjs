/** Objective frame-successions report for the unmodified Playwright recording.
 * Pixel differences are diagnostics, never a claim of biomechanical validation.
 */
import { execFileSync } from 'node:child_process';
import { readdir,readFile,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(process.argv[2]??'/tmp/viscera-cavity-contact/baseline-v2'),dir=path.join(root,'video');
const videos=(await readdir(dir)).filter(n=>n.endsWith('.webm'));
if(videos.length!==1)throw new Error(`Expected exactly one original recording, found ${videos.length}`);
const video=path.join(dir,videos[0]),out=path.join(root,'video-analysis');await mkdir(out,{recursive:true});
const ffmpeg=process.env.FFMPEG??'/opt/homebrew/bin/ffmpeg',ffprobe=process.env.FFPROBE??'/opt/homebrew/bin/ffprobe';
const probe=JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',video],{encoding:'utf8'}));
const stream=probe.streams.find(s=>s.codec_type==='video');
const raw=execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-i',video,'-vf','fps=10,crop=1260:780:0:138,format=yuv444p,tblend=all_mode=difference,signalstats,metadata=mode=print:file=-','-an','-f','null','-'],{encoding:'utf8',maxBuffer:50*1024*1024});
await writeFile(path.join(out,'consecutive-frame-signal.txt'),raw);
const frames=[];let current;
for(const line of raw.split('\n')){const head=/^frame:(\d+).*pts_time:([\d.]+)/.exec(line);if(head){current={frame:Number(head[1]),seconds:Number(head[2])};frames.push(current);}else{const value=/^lavfi.signalstats.(\w+)=(.*)/.exec(line);if(current&&value)current[value[1]]=Number(value[2]);}}
const sorted=frames.map(f=>f.YAVG).filter(Number.isFinite).sort((a,b)=>a-b),q=p=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))];
const top=[...frames].sort((a,b)=>b.YAVG-a.YAVG).filter((f,i,all)=>all.slice(0,i).every(g=>Math.abs(g.seconds-f.seconds)>.6)).slice(0,8);
for(const frame of top)execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-ss',String(frame.seconds),'-i',video,'-frames:v','1','-y',path.join(out,`motion-${frame.seconds.toFixed(1)}s.png`)]);
const receipt=JSON.parse(await readFile(path.join(root,'receipt.json'),'utf8'));
const cases=receipt.cases.map(c=>({key:c.key,status:c.status,warnings:c.summary?.warnings??[],maxReactionN:c.summary?.maxReactionN,maxUploadGapMm:c.summary?.maxUploadGapMm,minimumTipClearanceMm:c.summary?.minClearanceMm,peakObservedDisplacementMm:Math.max(0,...c.samples.map(s=>s.snapshot.physics?.displacement_mm??0)),recovery:c.summary?.recovery,diagnosticTimestamps:c.samples.map(s=>({label:s.label,observedMs:s.capturedAtMs,publishedMs:s.snapshot.wall_time_ms,ageMs:s.capturedAtMs-s.snapshot.wall_time_ms})),neighbourResponseMm:c.summary?.responses}));
await writeFile(path.join(out,'summary.json'),JSON.stringify({source:video,recording:{width:stream.width,height:stream.height,frameRate:stream.avg_frame_rate,durationSeconds:Number(probe.format.duration),codec:stream.codec_name},analysis:{sampleHz:10,crop:{x:0,y:138,width:1260,height:780},description:'Mean absolute luma difference between actual consecutive video samples at100ms spacing. Includes tool, lighting and UI effects. High values during camera movement and scene reset are expected. No interpolated frames or postprocessed images.',frames:frames.length,meanAbsoluteDifference8bit:{p50:q(.5),p95:q(.95),p99:q(.99),max:sorted.at(-1)},unchangedFraction:frames.filter(f=>f.YAVG<.01).length/frames.length,largestDifferences:top},cases},null,2));
console.log(JSON.stringify({output:out,frames:frames.length,p95:q(.95),cases:cases.length,contact:cases.filter(c=>c.status==='contact').length,warnings:cases.flatMap(c=>c.warnings)}));
