declare const __CHICKPEA_BUILD_IDENTITY__: {
  version: string;
  sourceCommit: string | null;
};

/** Build-time mode: true for every Vite serve lane, false for `vite build`. */
declare const __CHICKPEA_VITE_SERVE__: boolean;
