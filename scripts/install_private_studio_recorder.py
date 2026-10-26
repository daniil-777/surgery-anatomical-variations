"""Install the existing private browser studio on this Mac, using its existing access hash.

The source login implementation and a tested static build must already exist.
No credentials are generated, printed, or embedded in browser assets.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--build', type=Path, required=True)
parser.add_argument('--application', choices=['viscera', 'generation-lab'], default='viscera')
args = parser.parse_args()
source = Path(__file__).resolve().parents[1]
for file in ['services/web/studio_access.py', 'services/web/private_preview.py', 'services/web/recording_assets.py', 'data/studio-access.json']:
    if not (source / file).is_file():
        raise SystemExit(f'Private workspace missing required file: {file}')
if not (args.build / 'recorder/manifest.json').is_file():
    raise SystemExit('Build does not contain the tested recorder.')
is_lab = args.application == 'generation-lab'
port = 5181 if is_lab else 5180
label = 'com.generation-lab.private-studio' if is_lab else 'com.viscera.private-studio'
app_directory = 'GenerationLab' if is_lab else 'Viscera'
base = Path.home() / 'Library/Application Support' / app_directory / 'private-studio'
origin = f'http://127.0.0.1:{port}'
release = base / 'releases/app-recorder-2026-10-26'
agent = Path.home() / 'Library/LaunchAgents' / f'{label}.plist'
if agent.exists() or release.exists():
    raise SystemExit('A private studio installation already exists; inspect it before replacing it.')
base.mkdir(parents=True, exist_ok=True)
(base / 'data').mkdir(mode=0o700, exist_ok=True)
shutil.copytree(args.build, release / 'public-copy')
for file in ['services/__init__.py', 'services/web/__init__.py', 'services/web/studio_access.py', 'services/web/private_preview.py', 'services/web/recording_assets.py']:
    destination = release / file
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / file, destination)
shutil.copytree(source / 'services/web/login', release / 'services/web/login', ignore=shutil.ignore_patterns('.*', '* 2.*', '* 3.*'))
shutil.copytree(source / 'apps/studio/public/recorder', release / 'apps/studio/public/recorder')
shutil.copy2(source / 'data/studio-access.json', base / 'data/studio-access.json')
os.chmod(base / 'data/studio-access.json', 0o600)
uv = shutil.which('uv') or '/opt/homebrew/bin/uv'
subprocess.run([uv, 'venv', str(base / 'runtime'), '--python', '3.11'], check=True)
python = base / 'runtime/bin/python'
subprocess.run([uv, 'pip', 'install', '--python', str(python), 'fastapi==0.115.12', 'uvicorn==0.34.3'], check=True)
config = {
    'Label':label,
    'ProgramArguments':[str(python),'-m','uvicorn','services.web.private_preview:app','--host','127.0.0.1','--port',str(port)],
    'WorkingDirectory':str(release), 'RunAtLoad':True, 'KeepAlive':True, 'ThrottleInterval':10,
    'StandardOutPath':str(base/'server.log'), 'StandardErrorPath':str(base/'server.log'),
    'EnvironmentVariables':{
        'PYTHONPATH':str(release), 'PYTHONDONTWRITEBYTECODE':'1', 'PYTHONUNBUFFERED':'1',
        'VISCERA_AUTH_CONFIG':str(base/'data/studio-access.json'), 'VISCERA_AUTH_DB':str(base/'data/studio-access.sqlite'),
        'VISCERA_AUTH_ORIGIN':origin, 'VISCERA_WEB_DIST':str(release/'public-copy'),
    },
}
agent.parent.mkdir(parents=True,exist_ok=True)
with agent.open('wb') as f: plistlib.dump(config,f)
os.chmod(agent,0o600)
subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(agent)],check=True)
for _ in range(50):
    try:
        with urllib.request.urlopen(origin+'/auth/recorder/manifest.json',timeout=2) as response:
            manifest=json.load(response)
            if manifest == json.loads((release/'apps/studio/public/recorder/manifest.json').read_text()):
                print(f'Private studio available at {origin}/auth/login; recorder assets verified.')
                break
    except Exception:
        time.sleep(.2)
else: raise SystemExit('Private studio did not become ready; inspect its server.log.')
(base/'installation.json').write_text(json.dumps({'url':origin+'/auth/login','release':str(release),'recorder':manifest,'existingLoginConfigurationReused':True},indent=2)+'\n')
