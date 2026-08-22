/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PRICE_MONTHLY_USD: string;
  readonly VITE_PRICE_YEARLY_USD: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
