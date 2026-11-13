import { requireOptionalNativeModule } from 'expo';

type Fail = { ok: false; reason: string };

export type RegisterResult =
  | {
      ok: true;
      /** Row-major homography mapping moving-image px → reference px, CoreImage coords (y up). */
      h: number[];
      /** Working-image size the homography is expressed in. */
      width: number;
      height: number;
      /** Mean absolute difference vs the reference before / after warping (0–1). */
      diffBefore: number;
      diffAfter: number;
    }
  | Fail;

export type AlignNativeResult = (RegisterResult & { ok: true; uri: string }) | Fail;

export type EdgesResult = { ok: true; uri: string; width: number; height: number } | Fail;

type EnvAlignModule = {
  align(refUri: string, movUri: string, outUri: string, outLong: number): Promise<AlignNativeResult>;
  register(refUri: string, movUri: string, workLong: number): Promise<RegisterResult>;
  edges(uri: string, outUri: string, long: number): Promise<EdgesResult>;
};

/** null in Expo Go (the native module only exists in the EnvRevisit build). */
export const EnvAlign = requireOptionalNativeModule<EnvAlignModule>('EnvAlign');
