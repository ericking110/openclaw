import { css } from "lit";

export const kbdStyles = css`
  /* Keep context-owned line height and chrome; center symbols without stretching them. */
  .shortcut-kbd:where(:not([hidden])) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: middle;
  }

  .shortcut-kbd > span + span {
    margin-inline-start: 0.15em;
  }

  /* Center the visible capitals, not the font’s extra ascender/descender space. */
  .kbd__text {
    text-box: trim-both cap alphabetic;
  }

  /* Preserve the text line box when a key contains only an SVG. Existing numeric
   picker ::before content keeps its natural width and remains the same owner. */
  .shortcut-kbd::before {
    content: "";
    height: 1lh;
  }
`;
