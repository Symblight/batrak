// Not `/// <reference types="vite/client" />` — its own `*?inline` ambient declaration (typed
// `string`) wins over the `*.css?inline` one below, though postcss-lit turns these into a Lit
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
