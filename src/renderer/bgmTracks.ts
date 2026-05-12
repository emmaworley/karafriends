export interface BgmTrack {
  filename: string;
  label: string;
}

export const BGM_DIR = "./bgm/";

export const BGM_TRACKS: readonly BgmTrack[] = [
  {
    filename: "joysound-magazine-song-selection.webm",
    label: "JOYSOUND Switch",
  },
];
