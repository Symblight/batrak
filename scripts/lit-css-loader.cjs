// Wraps css-loader's string export (`*.css?inline`) in Lit's `unsafeCSS()`, so
// `static styles = styles` gets a CSSResult.
/** @param {string} source */
module.exports = function litCssLoader(source) {
  const marker = 'export default ';
  const at = source.lastIndexOf(marker);
  if (at < 0) throw new Error('lit-css-loader: no default export from css-loader');
  return `import { unsafeCSS } from 'lit';\n${source.slice(0, at)}export default unsafeCSS(${source
    .slice(at + marker.length)
    .replace(/;\s*$/, '')});\n`;
};
