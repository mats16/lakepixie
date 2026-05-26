/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DATABRICKS_HOST: string;
  readonly VITE_DATABRICKS_APPS_CONSOLE_URL_TEMPLATE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
