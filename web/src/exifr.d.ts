declare module 'exifr/dist/lite.esm.mjs' {
  export function gps(input: Blob): Promise<{ latitude: number; longitude: number } | undefined>;
}
