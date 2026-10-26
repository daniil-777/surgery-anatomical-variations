import { createRoot } from 'react-dom/client';
import { useEffect, useRef } from 'react';
import { VideoRecorderProvider, useVideoRecorder } from '../../VideoRecorderPanel';
import { CHANNEL, LOCK } from './protocol';
import './window.css';

function Bridge() {
  const controls = useVideoRecorder(), current = useRef(controls);
  current.current = controls;
  const channel = useRef<BroadcastChannel | null>(null);
  const send = () => {
    const s = current.current.state;
    if (!s) return;
    channel.current?.postMessage({ type: 'state', status: s.status, elapsedMs: s.elapsedMs,
      audioEnabled: s.audioEnabled, microphoneMuted: s.microphoneMuted });
    document.title = `${s.status === 'recording' ? '● Recording' : s.status === 'paused' ? 'Ⅱ Paused' : 'App recorder'} — Generation Lab`;
  };
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel(CHANNEL); channel.current = bc;
    bc.onmessage = ({ data }) => {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'status-request') send();
      if (data.type === 'focus') window.focus();
      if (data.type === 'control') {
        if (data.action === 'stop') current.current.stop();
        if (data.action === 'pause') current.current.pause();
        if (data.action === 'mute') current.current.mute();
      }
    };
    const closed = () => bc.postMessage({ type: 'closed' });
    window.addEventListener('pagehide', closed);
    send();
    return () => { window.removeEventListener('pagehide', closed); bc.close(); channel.current = null; };
  }, []);
  useEffect(send, [controls.state]);
  return null;
}

const root = createRoot(document.getElementById('root')!);
const mount = () => root.render(<VideoRecorderProvider appWindow><Bridge /></VideoRecorderProvider>);
// An unrelated tab can open a second named popup. Never let it start a second recorder.
if (navigator.locks) {
  void navigator.locks.request(LOCK, { ifAvailable: true }, async lock => {
    if (!lock) {
      root.render(<main className="recorder-duplicate"><p>GENERATION LAB / CAPTURE</p><h1>Your recorder is already open.</h1>
        <p>Return to its window to manage or download your video. After closing it, you can reopen the recorder here.</p>
        <button onClick={() => { const bc = new BroadcastChannel(CHANNEL); bc.postMessage({ type: 'focus' }); bc.close(); }}>Find recording window</button>
        <button onClick={() => location.reload()}>Try again</button></main>);
      return;
    }
    mount();
    await new Promise<void>(resolve => window.addEventListener('pagehide', () => resolve(), { once: true }));
  });
} else mount();
