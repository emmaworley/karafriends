import React, { useEffect, useRef } from "react";

import usePlaybackState from "../common/hooks/usePlaybackState";
import { BGM_DIR } from "./bgmTracks";

const BGM_VOLUME = 0.3;

interface Props {
  trackFilename: string | null;
}

export default function BackgroundMusic({ trackFilename }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const { playbackState } = usePlaybackState();
  const shouldPlay = trackFilename !== null && playbackState === "WAITING";

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = BGM_VOLUME;
  }, [trackFilename]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (shouldPlay) {
      audio.play().catch((e) => console.warn("BGM autoplay failed", e));
    } else {
      audio.pause();
    }
  }, [shouldPlay]);

  if (!trackFilename) return null;
  return <audio ref={audioRef} src={`${BGM_DIR}${trackFilename}`} loop />;
}
