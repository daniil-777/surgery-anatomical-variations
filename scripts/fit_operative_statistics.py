#!/usr/bin/env python3
"""Fit and test aggregate red-chroma morphology; no neural training or albedo recovery."""
from __future__ import annotations
import argparse, hashlib, json, time, platform
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage, optimize, stats

SIGMAS=(1.,2.,4.,8.,16.,32.)
QUANTILES=np.linspace(0,1,257)

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def dump(p,x): Path(p).write_text(json.dumps(x,indent=2,allow_nan=False)+'\n')
def bands(x,mode='reflect'):
    layers=[x]+[ndimage.gaussian_filter(x,sigma,mode=mode) for sigma in SIGMAS]
    return [layers[i]-layers[i+1] for i in range(len(SIGMAS))]
def energies(x,valid=None,mode='reflect'):
    valid=np.ones(x.shape,bool) if valid is None else valid
    return np.array([np.mean(b[valid]**2) for b in bands(x,mode)])
def finite_fill(x,valid):
    if valid.all(): return x
    _,nearest=ndimage.distance_transform_edt(~valid,return_indices=True)
    return x[tuple(nearest)]
def describe(x,valid,threshold=None):
    e=energies(x,valid)
    a=x[valid]; std=float(np.std(a)); q=np.quantile(a,QUANTILES)
    yy,xx=np.gradient(x); tensor=np.array([[np.mean(xx[valid]**2),np.mean((xx*yy)[valid])],[np.mean((xx*yy)[valid]),np.mean(yy[valid]**2)]])
    vals,vec=np.linalg.eigh(tensor); direction=vec[:,1]
    anisotropy=float((vals[1]-vals[0])/max(vals.sum(),1e-15))
    # Correlation is pair-normalized; excludes invalid endpoints and never wraps source ROI.
    centered=x-a.mean(); corr=[]
    for d in range(1,min(33,min(x.shape)//3)):
        validx=valid[:,d:]&valid[:,:-d]; validy=valid[d:,:]&valid[:-d,:]
        cx=float(np.mean((centered[:,d:]*centered[:,:-d])[validx])) if validx.any() else 0
        cy=float(np.mean((centered[d:,:]*centered[:-d,:])[validy])) if validy.any() else 0
        corr.append([d,cx/max(std**2,1e-15),cy/max(std**2,1e-15)])
    threshold=float(np.quantile(a,.8)) if threshold is None else float(threshold)
    mask=valid&(x>threshold); labels,n=ndimage.label(mask)
    sizes=np.bincount(labels.ravel())[1:]; sizes=sizes[sizes>=3]
    result={'valid_pixels':int(valid.sum()),'mean':float(a.mean()),'std':std,'quantile_values':q.tolist(),
      'band_energy':e.tolist(),'band_energy_fraction':(e/max(e.sum(),1e-15)).tolist(),
      'anisotropy':anisotropy,'gradient_direction_degrees':float(np.degrees(np.arctan2(direction[1],direction[0]))),
      'correlation_xy':corr,'threshold':threshold,'coverage':float(mask.sum()/valid.sum()),
      'components_ge3px':int(len(sizes)),'component_area_px_quantiles':np.quantile(sizes,[.1,.5,.9]).tolist() if len(sizes) else [0.,0.,0.]}
    return result

def load_rois(manifest, partition):
    fitids=set(manifest['fit_surgery_ids']); holdids=set(manifest['holdout_surgery_ids']); assert not fitids&holdids
    rois=[]
    for row in manifest['rois']:
        if row['research_partition'] != partition: continue
        p=Path(row['source_image']); assert sha(p)==row['source_sha256'],f'hash differs: {p}'
        split=row['research_partition']; assert row['surgery_id'] in (fitids if split=='fit' else holdids)
        with Image.open(p) as image:
            assert image.size==(1280,1024)
            x0,y0,x1,y1=row['bounds_xyxy_exclusive']; assert 0<=x0<x1<=1280 and 0<=y0<y1<=1024
            rgb=np.asarray(image.convert('RGB'))[y0:y1,x0:x1].astype(float)
        lo=rgb.min(2);hi=rgb.max(2)
        valid=~(((lo>180)&(hi>230))|((hi-lo<22)&(hi>210))|(hi<30)|(lo<8))
        assert valid.sum()>100
        # Multiplicative exposure cancels approximately in log chromaticity.
        # These are uncalibrated display RGBs; this is not pigment concentration.
        red=np.log((rgb[...,0]+4)/np.sqrt((rgb[...,1]+4)*(rgb[...,2]+4)))
        red=finite_fill(red,valid)
        residual=red-ndimage.gaussian_filter(red,32,mode='reflect')
        meta={k:row[k] for k in ['id','dataset','source_split','research_partition','surgery_id','frame_id','source_sha256','bounds_xyxy_exclusive','visual_class','annotation_author']}
        rois.append((meta,residual,valid,describe(residual,valid)))
    return rois

def synthesize(model,side,seed):
    rng=np.random.default_rng(seed); basis=[]
    for i in range(len(SIGMAS)):
        a=rng.standard_normal((side,side)); b=bands(a,mode='wrap')[i];b-=b.mean();b/=max(b.std(),1e-10);basis.append(b)
    response=np.stack([energies(x,mode='wrap') for x in basis],axis=1)
    target=np.array(model['band_energy']); weights,_=optimize.nnls(response,target)
    raw=sum(np.sqrt(w)*b for w,b in zip(weights,basis));raw=(raw-raw.mean())/max(raw.std(),1e-15)
    # One-dimensional empirical quantile transport replaces the Gaussian marginal;
    # layout is entirely from newly seeded periodic random noise.
    field=np.interp(stats.norm.cdf(raw),QUANTILES,model['quantile_values'])
    low,high=np.array(model['quantile_values'])[[0,-1]]
    red=np.clip((field-low)/max(high-low,1e-12),0,1)
    # G/B are explicit authored auxiliary fields, independent of learned/source layout.
    wet=ndimage.gaussian_filter(rng.standard_normal((side,side)),7,mode='wrap');wet=(wet-wet.mean())/wet.std()
    fine=ndimage.gaussian_filter(rng.standard_normal((side,side)),.8,mode='wrap');fine=(fine-fine.mean())/fine.std()
    rgba=np.stack([red,stats.norm.cdf(wet),stats.norm.cdf(fine),np.ones_like(red)],axis=-1)
    rgba=np.rint(rgba*255).astype('uint8')
    return rgba,field,weights,response,[float(low),float(high)]

def compare(desc,target):
    e=np.array(desc['band_energy_fraction']);t=np.array(target['band_energy_fraction'])
    return {'band_energy_fraction_L1':float(np.abs(e-t).sum()),
        'log_std_ratio':float(np.log(max(desc['std'],1e-12)/max(target['std'],1e-12))),
        'red_residual_quantile_W1':float(np.abs(np.array(desc['quantile_values'])-np.array(target['quantile_values'])).mean()),
        'coverage_error_at_frozen_fit_threshold':float(desc['coverage']-target['coverage']),
        'anisotropy_abs_error':abs(desc['anisotropy']-target['anisotropy'])}

def main():
    p=argparse.ArgumentParser();p.add_argument('--roi-manifest',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--seed',type=int,default=42);p.add_argument('--side',type=int,default=512);args=p.parse_args()
    assert args.side in (128,256,512,1024)
    started=time.perf_counter();args.output.mkdir(parents=True,exist_ok=True)
    manifest=json.loads(args.roi_manifest.read_text());rois=load_rois(manifest, 'fit')
    groups={};training=[]
    for meta,field,valid,desc in rois:
        if meta['research_partition']=='fit': groups.setdefault(meta['visual_class'],[]).append((meta,field,valid,desc));training.append(meta)
    models={}
    for name,items in groups.items():
        # Equal ROI weighting, with independent surgery count stated; all present classes have one ROI.
        d={key:np.mean([x[3][key] for x in items],axis=0).tolist() for key in ['band_energy','band_energy_fraction','quantile_values']}
        d.update({key:float(np.mean([x[3][key] for x in items])) for key in ['std','mean','anisotropy','threshold','coverage']})
        d.update({'training_roi_ids':[x[0]['id'] for x in items],'training_surgery_ids':sorted({x[0]['surgery_id'] for x in items})})
        models[name]=d
    # Freeze serialized model before opening/evaluating holdout image payloads.
    # The fixed feature transform and hyperparameters are never refit on holdout data.
    model={'schema':'viscera.operative-appearance-statistics/v1','method':'train-only multiscale log-red-chromaticity residual statistics; no neural training',
      'feature':'log((sRGB_R+4)/sqrt((sRGB_G+4)*(sRGB_B+4))) minus Gaussian sigma32; native pixel coordinates',
      'sigmas_px':SIGMAS,'bands':'[identity-gaussian1, gaussian1-gaussian2, ..., gaussian16-gaussian32]',
      'quantile_probabilities':QUANTILES.tolist(),'models':models,'manifest_sha256':sha(args.roi_manifest),
      'source_script_sha256':sha(__file__),'training_rois':training,
      'rights':{'publisher_license':'CC BY 4.0','source':'https://huggingface.co/datasets/nct-tso/dsad','paper':'https://www.nature.com/articles/s41597-022-01719-2','restriction_note':'Publisher metadata CC BY4.0; paper prose says noncommercial. Existing project treats DSAD-derived models as research-only until discrepancy clarified. No GynSurg data used.'},
      'limitations':['Assistant-reviewed regional labels, no expert pixel truth','One fit ROI per visual class; no clinical or broad generalization claim','Source pixel scale is uncalibrated; no physical-mm inference','No learned albedo, BRDF, film thickness or fluid dynamics','Inputs are publisher JPEG preview renditions stored under .png filenames; compression affects high-frequency statistics. No publisher masks treated as exact truth','Fitted descriptors retain appearance statistics; not source pixel layouts']}
    dump(args.output/'model.json',model)
    target=models['thin_red_film'];rgba,field,weights,response,decode=synthesize(target,args.side,args.seed)
    imagepath=args.output/f'operative-statistical-descriptor-seed{args.seed}.png';Image.fromarray(rgba).save(imagepath)
    generated=describe(field,np.ones(field.shape,bool),target['threshold'])
    rois += load_rois(manifest, 'holdout')
    evaluations=[]
    for meta,field,valid,desc in rois:
        name=meta['visual_class'];target_class=models.get(name)
        if meta['research_partition']=='holdout' and target_class:
            desc=describe(field,valid,target_class['threshold']);metrics=compare(desc,target_class)
        else: metrics=None
        evaluations.append({'roi':meta,'observed':desc,'holdout_vs_frozen_fit':metrics})
    # Check all seams against native neighbor variation; periodic lattice has no duplicated endpoint pixels.
    r=rgba[...,0].astype(float)/255
    seam=(np.abs(r[:,0]-r[:,-1]).mean()+np.abs(r[0,:]-r[-1,:]).mean())/2
    interior=(np.abs(np.diff(r,axis=0)).mean()+np.abs(np.diff(r,axis=1)).mean())/2
    report={'schema':'viscera.operative-appearance-statistical-fit-report/v1','model_sha256':sha(args.output/'model.json'),
      'roi_manifest_sha256':sha(args.roi_manifest),'source_script_sha256':sha(__file__),
      'fit_surgeries':manifest['fit_surgery_ids'],'holdout_surgeries':manifest['holdout_surgery_ids'],
      'roi_count':len(rois),'fit_roi_count':len(training),'evaluations':evaluations,
      'texture':{'file':str(imagepath),'sha256':sha(imagepath),'resolution':[args.side,args.side],'seed':args.seed,
        'meaning':'R fitted thin-film red-chroma residual surrogate; G authored independent smooth field; B authored independent fine field; A255. Linear data texture, not source RGB or albedo.',
        'r_decode_log_red_residual':decode,'nnls_variance_weights':weights.tolist(),'nnls_response_matrix':response.tolist(),
        'generated_vs_fit':compare(generated,target),'generated_observed':generated,'seam_to_interior_neighbor_ratio':float(seam/max(interior,1e-12))},
      'seconds':time.perf_counter()-started,'runtime':{'python':platform.python_version(),'numpy':np.__version__,'platform':platform.platform()},
      'qualification':'Tiny observational statistical pilot; no surgeon/clinical validation. Heldout mismatch is reported even when worse. Not a blood classifier.'}
    dump(args.output/'report.json',report)
    print(json.dumps({'seconds':report['seconds'],'fit_surgeries':report['fit_surgeries'],'holdout_surgeries':report['holdout_surgeries'],
      'texture':{k:v for k,v in report['texture'].items() if k not in ['generated_observed','nnls_response_matrix']},
      'holdout':[{k:x[k] for k in ['roi','holdout_vs_frozen_fit']} for x in evaluations if x['holdout_vs_frozen_fit']]},indent=2))
if __name__=='__main__': main()
