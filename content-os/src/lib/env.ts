/**
 * Centralised environment access. Public values are inlined by Next.js at
 * build time; server values must only be read from server code.
 */
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See content-os/.env.example and README.md.`,
    );
  }
  return value;
}

export const publicEnv = {
  get supabaseUrl() {
    return required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
  },
  get supabaseAnonKey() {
    return required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  },
  get siteUrl() {
    return (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  },
};

export const serverEnv = {
  get supabaseServiceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY);
  },
  /** 32-byte key, base64. Versioned keys: TOKEN_ENCRYPTION_KEY_V1, _V2 … */
  tokenEncryptionKey(version: number): string | undefined {
    return process.env[`TOKEN_ENCRYPTION_KEY_V${version}`];
  },
  get tokenEncryptionCurrentVersion(): number {
    return Number(process.env.TOKEN_ENCRYPTION_CURRENT_VERSION ?? "1");
  },
  get oauthStateSecret() {
    return required("OAUTH_STATE_SECRET", process.env.OAUTH_STATE_SECRET);
  },
  get instagram() {
    const appId = process.env.INSTAGRAM_APP_ID;
    const appSecret = process.env.INSTAGRAM_APP_SECRET;
    return {
      appId,
      appSecret,
      configured: Boolean(appId && appSecret && process.env.OAUTH_STATE_SECRET),
    };
  },
};
