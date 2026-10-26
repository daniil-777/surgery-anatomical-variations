import { ACTIVE, CHANNEL, WINDOW_NAME } from './protocol';

(() => {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script || document.documentElement.hasAttribute('data-lab-recorder-owner')) return;
  // Embedded apps share the parent's controls. A direct link still gets its own launcher.
  try { if (window.parent !== window && window.parent.document.documentElement.hasAttribute('data-lab-recorder-owner')) return; } catch { /* Other origins can use their own controller. */ }
  document.documentElement.setAttribute('data-lab-recorder-owner', '');
  const base = new URL('.', script.src), popupUrl = new URL('index.html', base).href;
  const host = document.createElement('lab-app-recorder'), shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = new URL('launcher.css', base).href;
  const group = document.createElement('div'); group.className = 'capture'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'App recording');
  const open = document.createElement('button'); open.type = 'button'; open.className = 'record'; open.setAttribute('aria-label', 'Record app with voice'); open.title = 'Record the whole app with optional microphone narration';
  const dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span'); label.textContent = 'Record app'; open.append(dot, label);
  const controls: Record<string, HTMLButtonElement> = {};
  const paths: Record<string, string> = {
    pause:'M8 5v14M16 5v14', play:'m8 5 11 7-11 7Z', stop:'M6 6h12v12H6Z',
    mic:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8',
    muted:'m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v4M5 10v2a7 7 0 0 0 12 5M19 10v2M12 19v3M8 22h8',
  };
  const icon = (button: HTMLButtonElement, name: string) => {
    if (button.dataset.icon === name) return;
    button.dataset.icon = name;
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    for (const [key,value] of Object.entries({viewBox:'0 0 24 24',width:'17',height:'17',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) svg.setAttribute(key,value);
    const path = document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d',paths[name]!); svg.append(path); button.replaceChildren(svg);
  };
  for (const [action, symbol, name] of [['pause','Ⅱ','Pause app recording'], ['mute','♪','Mute recording microphone'], ['stop','■','Stop app recording']]) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `control ${action}`; button.hidden = true; button.textContent = symbol!;
    button.setAttribute('aria-label', name!); button.title = name!;
    icon(button, action === 'mute' ? 'mic' : action!); controls[action!] = button;
  }
  const message = document.createElement('p'); message.className = 'message'; message.hidden = true; message.setAttribute('role', 'status');
  group.append(open, ...Object.values(controls)); shadow.append(style, group, message);
  let popup: Window | null = null;
  let state: {status: string; elapsedMs: number; audioEnabled: boolean; microphoneMuted: boolean} | null = null;
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
  const draw = () => {
    const active = state && ACTIVE.has(state.status), running = state && ['recording', 'paused'].includes(state.status);
    group.classList.toggle('active', Boolean(active)); group.classList.toggle('paused', state?.status === 'paused');
    label.textContent = active ? `${state!.status === 'paused' ? 'Paused ' : ''}${Math.floor(state!.elapsedMs / 60000).toString().padStart(2,'0')}:${Math.floor(state!.elapsedMs / 1000 % 60).toString().padStart(2,'0')}` : state?.status === 'completed' ? 'Save recording' : 'Record app';
    open.setAttribute('aria-label', active ? 'Open app recording controls' : state?.status === 'completed' ? 'Preview and save app recording' : 'Record app with voice');
    controls.pause!.hidden = !running;
    icon(controls.pause!, state?.status === 'paused' ? 'play' : 'pause');
    controls.pause!.setAttribute('aria-label', state?.status === 'paused' ? 'Resume app recording' : 'Pause app recording');
    controls.mute!.hidden = !running || !state?.audioEnabled;
    icon(controls.mute!, state?.microphoneMuted ? 'muted' : 'mic');
    controls.mute!.setAttribute('aria-label', state?.microphoneMuted ? 'Unmute recording microphone' : 'Mute recording microphone');
    controls.mute!.setAttribute('aria-pressed', String(Boolean(state?.microphoneMuted)));
    controls.stop!.hidden = !active; controls.stop!.disabled = state?.status === 'stopping';
    for (const button of Object.values(controls)) button.title = button.getAttribute('aria-label')!;
  };
  channel?.addEventListener('message', ({ data }) => {
    if (data?.type === 'closed') { state = null; draw(); }
    if (data?.type === 'state' && typeof data.status === 'string' && Number.isFinite(data.elapsedMs) && data.elapsedMs >= 0) { state = data; draw(); }
  });
  for (const [action, button] of Object.entries(controls)) button.onclick = () => channel?.postMessage({ type:'control', action });
  open.onclick = () => {
    message.hidden = true;
    // Never navigate an existing recorder: doing so would discard its stream and download.
    try {
      popup = popup && !popup.closed ? popup : window.open('', WINDOW_NAME, 'popup,width=700,height=940');
      if (!popup) throw new Error('popup-blocked');
      if (popup.location.href === 'about:blank') popup.location.replace(popupUrl);
      popup.focus(); channel?.postMessage({ type: 'focus' }); channel?.postMessage({ type: 'status-request' });
    } catch { message.textContent = 'Allow pop-ups for this site, then choose Record app again.'; message.hidden = false; }
  };
  const place = () => {
    const slot = [...document.querySelectorAll<HTMLElement>('[data-lab-recorder-slot]')].find(item => item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden');
    const parent = slot ?? document.body;
    if (parent && host.parentNode !== parent) parent.append(host);
    host.toggleAttribute('inline', Boolean(slot));
  };
  const ready = () => { place(); new MutationObserver(place).observe(document.body, { childList:true, subtree:true }); channel?.postMessage({ type: 'status-request' }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once:true }); else ready();
  window.addEventListener('resize', place);
  window.addEventListener('pageshow', () => channel?.postMessage({ type: 'status-request' }));
})();
