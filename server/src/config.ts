export interface ServerConfig {
  port: number;
  host: string;
  production: boolean;
  inviteCode: string;
  sessionSecret: string;
  allowedOrigins: string[];
  databaseUrl?: string;
  localSavePath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const inviteCode = env.INVITE_CODE ?? (production ? '' : 'ANT-LIFE-LOCAL');
  const sessionSecret = env.SESSION_SECRET ?? (production ? '' : 'local-only-session-key-change-before-deploy');
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

  if (production) {
    const missing = [
      !inviteCode && 'INVITE_CODE',
      sessionSecret.length < 32 && 'SESSION_SECRET (at least 32 characters)',
      !env.DATABASE_URL && 'DATABASE_URL (Neon PostgreSQL)',
      allowedOrigins.length === 0 && 'ALLOWED_ORIGINS',
    ].filter(Boolean);
    if (missing.length > 0) throw new Error(`Production configuration is incomplete: ${missing.join(', ')}`);
  }
  if (inviteCode.length < 6) throw new Error('INVITE_CODE must be at least 6 characters.');

  return {
    port: Number(env.PORT ?? 3001),
    host: '0.0.0.0',
    production,
    inviteCode,
    sessionSecret,
    allowedOrigins,
    databaseUrl: env.DATABASE_URL,
    localSavePath: env.LOCAL_SAVE_PATH ?? '.local/colony.json',
  };
}

export function originAllowed(origin: string | undefined, config: ServerConfig): boolean {
  if (!origin) return !config.production;
  if (!config.production) {
    try {
      const hostname = new URL(origin).hostname;
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.e2b.app') || hostname.endsWith('.e2b.dev') || config.allowedOrigins.includes(origin);
    } catch {
      return false;
    }
  }
  return config.allowedOrigins.includes(origin);
}
