declare const __GIT_SHA__: string;
declare const __BUILD_DATE__: string;
declare const __PREVIEW_PR__: string;

interface ImportMetaEnv {
  readonly VITE_BACKEND_API_BASE_URL?: string;
  readonly VITE_BACKEND_WS_BASE_URL?: string;
  // 'webgl' makes WebGL the renderer when the URL has no `?renderer` (the e2e build: E2E_RENDERER, #232)
  readonly VITE_RENDERER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
