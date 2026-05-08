declare module 'juice' {
  interface JuiceOptions {
    removeStyleTags?: boolean;
    preserveImportant?: boolean;
    preserveMediaQueries?: boolean;
    preserveFontFaces?: boolean;
    insertPreservedExtraCss?: boolean;
    extraCss?: string;
    applyAttributesTableElements?: boolean;
    applyHeightAttributes?: boolean;
    applyWidthAttributes?: boolean;
    inlinePseudoElements?: boolean;
    webResources?: Record<string, unknown>;
    [key: string]: unknown;
  }

  function juice(html: string, options?: JuiceOptions): string;

  namespace juice {
    function inlineContent(html: string, css: string, options?: JuiceOptions): string;
    function inlineDocument(document: unknown, css: string, options?: JuiceOptions): void;
  }

  export = juice;
}
