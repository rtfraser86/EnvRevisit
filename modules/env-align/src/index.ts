import { requireOptionalNativeModule } from 'expo';

export type AlignNativeResult =
  | {
      ok: true;
      uri: string;
      width: number;
      height: number;
      /** Homography, row-major, at the 1024 px working size (CoreImage coords). */
      h: number[];
      /** Mean absolute difference vs the reference before / after warping (0–1). */
      diffBefore: number;
      diffAfter: number;
    }
  | { ok: false; reason: string };

type EnvAlignModule = {
  align(refUri: string, movUri: string, outUri: string, outLong: number): Promise<AlignNativeResult>;
};

/** null in Expo Go (the native module only exists in the EnvRevisit build). */
export const EnvAlign = requireOptionalNativeModule<EnvAlignModule>('EnvAlign');
