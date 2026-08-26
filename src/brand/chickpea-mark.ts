import {
  CHICKPEA_FAVICON_DATA_URL,
  CHICKPEA_MARK_DATA_URL,
  CHICKPEA_WORDMARK_DATA_URL,
} from './chickpea-mark.generated.ts';

export {
  CHICKPEA_FAVICON_DATA_URL,
  CHICKPEA_MARK_DATA_URL,
  CHICKPEA_WORDMARK_DATA_URL,
};

export const CHICKPEA_MARK_HTML = `<span class="avatar"><img class="pea" src="${CHICKPEA_MARK_DATA_URL}" alt="" width="32" height="32" draggable="false"></span>`;

export const CHICKPEA_WORDMARK_CSS = `--chickpea-wordmark-image:url("${CHICKPEA_WORDMARK_DATA_URL}");`;

export const CHICKPEA_WORDMARK_HTML = '<span class="brand-wordmark" role="img" aria-label="Chickpea"></span>';

export const CHICKPEA_FAVICON_HTML = `<link rel="icon" type="image/png" sizes="32x32" href="${CHICKPEA_FAVICON_DATA_URL}"><link rel="icon" type="image/png" sizes="128x128" href="${CHICKPEA_MARK_DATA_URL}">`;
