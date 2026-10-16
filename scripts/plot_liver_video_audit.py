#!/usr/bin/env python3
"""Make the figure from independent trajectory-audit.json; no simulation rerun."""
import argparse,json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
p=argparse.ArgumentParser();p.add_argument('--audit',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();d=json.loads(a.audit.read_text())
fig,ax=plt.subplots(1,3,figsize=(15,4.3),layout='constrained')
for index,label,color in [(3,'Historical vertex contact','#c24343'),(0,'Surface quadrature contact','#137969')]:
 rows=d['experiments'][index]['rows'];load=[r for r in rows if r['phase']=='loading']
 ax[0].plot([r['tool_path_distance_mm'] for r in load],[r['force_magnitude_n'] for r in load],'-o',label=label,color=color,markersize=3)
ax[0].set(xlabel='Tool travel during loading (mm)',ylabel='Simulated reaction magnitude (N)',title='A. Historical contact-loss regression');ax[0].legend(fontsize=8)
for index,label in [(0,'Indent'),(1,'Grasp'),(2,'Predefined seam cut')]:
 rows=d['experiments'][index]['rows'];ax[1].plot([r['time_s'] for r in rows],[r['minimum_jacobian'] for r in rows],label=label)
ax[1].set(xlabel='Protocol simulation time (s)',ylabel='Minimum det(F)',title='B. Recorded FEM element validity');ax[1].legend(fontsize=8)
rows=d['instruments']['push_samples'];t0=rows[0]['simulation_time_s'];times=[r['simulation_time_s']-t0 for r in rows]
for key,label in [('centroid_displacement_mm','Centroid translation'),('rigid_aligned_rms_mm','Rigid-aligned shape RMS'),('all_pair_distance_change_rms_mm','Pair-distance change RMS')]:
 ax[2].plot(times,[r[key] for r in rows],label=label)
ax[2].set(xlabel='Time since first held-push sample (s)',ylabel='Displacement/change (mm)',title='C. Free liver: slide versus deformation');ax[2].legend(fontsize=8)
for panel in ax:panel.grid(alpha=.2)
fig.suptitle('Independent saved-trajectory audit • simulated evidence, no measured tissue reference',fontsize=13)
a.output.parent.mkdir(parents=True,exist_ok=True);fig.savefig(a.output,dpi=160)
