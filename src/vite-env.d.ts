declare const __GIT_SHA__: string;
declare const __BUILD_DATE__: string;
declare const __PREVIEW_PR__: string;

interface ImportMetaEnv {
  readonly VITE_BACKEND_API_BASE_URL?: string;
  readonly VITE_BACKEND_WS_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
