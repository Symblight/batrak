// Not `/// <reference types="@rsbuild/core/types" />` — its `*?inline` declaration (typed `string`)
// would collide with the `*.css?inline` one below, which `scripts/lit-css-loader.cjs` turns into a Lit
// CSSResult at build time. Declaring only what the app needs avoids the collision.
declare module '*.css?inline' {
  import { CSSResultGroup } from 'lit';
  const content: CSSResultGroup;
  export default content;
}
declare module '*.svg?raw' {
  const content: string;
  export default content;
}
declare module '*.css';

declare module '@symblight/md-colors/client' {
  export function generateTheme(options: {
    sourceColor: string;
    scheme?: 'light' | 'dark';
  }): void;
}

interface ImportMeta {
  readonly env: { readonly DEV: boolean };
}
