/** Resolve once per capture; only summary crosses the client boundary. */
export interface TranscriptionSummary {
  backend: string;
  label: string;
  model: string;
  source: 'user' | 'platform' | 'environment';
}
export interface TranscriptionConfig {
  url: string;
  token: string;
  model: string;
  summary: TranscriptionSummary;
}
export interface IdentitySettings { url: string; secret: string; apiKey?: string; deploymentUrl?: string; }

export class TranscriptionSettingsError extends Error {
  constructor(message: string, public status = 503) { super(message); }
}

export function transcriptionResolver(defaults: { url: string; token: string; model: string }, identity?: IdentitySettings) {
  const fallback = (): TranscriptionConfig => ({ ...defaults, summary: {
    backend: 'deployment', label: 'Deployment endpoint', model: defaults.model, source: 'environment',
  } });
  return async (apiKey = ''): Promise<TranscriptionConfig> => {
    if (!identity) return fallback();
    if (!identity.url || !identity.secret) throw new TranscriptionSettingsError('TINA identity URL and internal secret are required');
    let response: Response;
    try {
      response = await fetch(`${identity.url.replace(/\/+$/, '')}/internal/transcription/resolve`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': identity.secret },
        body: JSON.stringify({ token: apiKey || identity.apiKey || '' }),
      });
    } catch { throw new TranscriptionSettingsError('TINA settings service is unavailable'); }
    if (!response.ok) {
      if (response.status === 401) throw new TranscriptionSettingsError('Capture API key is invalid or expired', 401);
      if (response.status === 403) throw new TranscriptionSettingsError('Capture API key or settings access was refused', 403);
      throw new TranscriptionSettingsError('Could not resolve the selected transcription backend');
    }
    let config: any;
    try { config = await response.json(); } catch { throw new TranscriptionSettingsError('Invalid transcription settings response'); }
    if (config?.disabled) throw new TranscriptionSettingsError('Transcription is stopped for this account; start it in Settings', 409);
    if (!['deployment', 'custom', 'apple', 'nvidia', 'funasr', 'sherpa', 'gipformer', 'viegem'].includes(config?.backend)) {
      throw new TranscriptionSettingsError('Invalid transcription backend');
    }
    if (!config.url && config.backend === 'deployment') return fallback();
    if (typeof config.url !== 'string' || (config.token != null && typeof config.token !== 'string')) {
      throw new TranscriptionSettingsError('The selected transcription backend is not configured');
    }
    let url: URL;
    try {
      url = new URL(config.backend === 'deployment' && identity.deploymentUrl ? identity.deploymentUrl : config.url);
    } catch { throw new TranscriptionSettingsError('Invalid transcription endpoint'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new TranscriptionSettingsError('Invalid transcription endpoint');
    }
    // Settings are shared with Docker bots; the native Desktop reaches the same host over loopback.
    if (url.hostname === 'host.docker.internal') url.hostname = '127.0.0.1';
    const summary = config.summary;
    if (!summary || !['user', 'platform', 'environment'].includes(summary.source)
        || typeof summary.label !== 'string' || summary.label.length > 180) {
      throw new TranscriptionSettingsError('Invalid transcription settings summary');
    }
    const model = typeof config.model === 'string' && config.model ? config.model : 'whisper-1';
    return {
      url: url.toString().replace(/\/+$/, ''), token: config.token || '', model,
      summary: { backend: config.backend, label: summary.label, model, source: summary.source },
    };
  };
}
