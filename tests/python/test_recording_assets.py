from services.web.recording_assets import ASSETS, recording_asset


def test_all_recorder_assets_are_available():
    for name in ASSETS:
        response = recording_asset(name)
        assert response.status_code == 200
        assert response.headers['x-content-type-options'] == 'nosniff'


def test_only_recorder_files_can_be_read():
    for name in ('../studio_access.py', '../../data/studio-access.json', '/etc/passwd', 'index.html/../secret', '', 'main.tsx'):
        assert recording_asset(name).status_code == 404
