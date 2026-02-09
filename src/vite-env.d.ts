declare const __GIT_SHA__: string;

interface ImportMetaEnv {
  readonly VITE_BACKEND_API_BASE_URL?: string;
  readonly VITE_BACKEND_WS_BASE_URL?: string;
  readonly VITE_BACKEND_ADMIN_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
