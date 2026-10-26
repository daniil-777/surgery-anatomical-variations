/** Only capture status/controls cross windows. Never send media, URLs, credentials or device IDs. */
export const CHANNEL = 'generation-lab-recorder-v1';
export const WINDOW_NAME = 'generation-lab-recorder';
export const LOCK = 'generation-lab-recorder-owner';
export const ACTIVE = new Set(['acquiring', 'recording', 'paused', 'stopping']);
