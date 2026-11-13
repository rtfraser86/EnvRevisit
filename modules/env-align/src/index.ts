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
export type FileResult = { ok: true; uri: string; width: number; height: number } | Fail;
export type EdgesResult = FileResult;
export type ChangeMapResult = { ok: true; uri: string; width: number; height: number; changed: number } | Fail;
export type TimelapseResult = { ok: true; uri: string; frames: number; width: number; height: number } | Fail;

type EnvAlignModule = {
  align(refUri: string, movUri: string, outUri: string, outLong: number): Promise<AlignNativeResult>;
  register(refUri: string, movUri: string, workLong: number): Promise<RegisterResult>;
  edges(uri: string, outUri: string, long: number): Promise<EdgesResult>;
  // Added in native version 2. Optional so newer JS still runs on an older build.
  /** h: row-major, photo px → output px, origin top-left on both sides. */
  warp?(movUri: string, outUri: string, h: number[], outW: number, outH: number): Promise<FileResult>;
  changeMap?(aUri: string, bUri: string, outUri: string, long: number): Promise<ChangeMapResult>;
  zipFolder?(dirUri: string, outUri: string): Promise<{ ok: true; uri: string } | Fail>;
  timelapse?(
    frames: string[],
    labels: string[],
    outUri: string,
    format: 'mp4' | 'gif',
    long: number,
    seconds: number
  ): Promise<TimelapseResult>;
  /** Registers the newest camera video frame against the ghost. reason 'no-camera' = not attached. */
  liveMatch?(refUri: string, hold: 'portrait' | 'cw' | 'ccw', workLong: number): Promise<RegisterResult>;
  liveStop?(): Promise<boolean>;
};

/** null in Expo Go (the native module only exists in the EnvRevisit build). */
export const EnvAlign = requireOptionalNativeModule<EnvAlignModule>('EnvAlign');

/** True when the installed build has the version-2 native functions (exports, tie points, video matching). */
export const hasNativeV2 = typeof EnvAlign?.warp === 'function';
