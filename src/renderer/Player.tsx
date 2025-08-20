import invariant from "ts-invariant";

import Hls from "hls.js";

import React, { useEffect, useRef, useState } from "react";
import { commitMutation, fetchQuery, graphql } from "react-relay";
import YoutubePlayer from "youtube-player";
import { PlayerPopSongMutation } from "./__generated__/PlayerPopSongMutation.graphql";

import environment from "../common/graphqlEnvironment";
import usePitchShiftSemis from "../common/hooks/usePitchShiftSemis";
import usePlaybackState from "../common/hooks/usePlaybackState";
import { KuroshiroSingleton } from "../common/joysoundParser";
import AdhocLyrics from "./AdhocLyrics";
import JoysoundRenderer from "./JoysoundRenderer";
import { InputDevice } from "./nativeAudio";
import PianoRoll from "./PianoRoll";
import "./Player.css";
import KarafriendsAudio from "./webAudio";

const popSongMutation = graphql`
  mutation PlayerPopSongMutation {
    popSong {
      ... on DamQueueItem {
        __typename
        songId
        streamingUrls {
          url
        }
        scoringData
        timestamp
        streamingUrlIdx
        name
        artistName
      }
      ... on JoysoundQueueItem {
        __typename
        songId
        timestamp
        name
        artistName
        isRomaji
        youtubeVideoId
      }
      ... on YoutubeQueueItem {
        __typename
        songId
        timestamp
        hasAdhocLyrics
        hasCaptions
        gainValue
        name
      }
      ... on NicoQueueItem {
        __typename
        songId
        timestamp
        name
      }
    }
  }
`;

const POLL_INTERVAL_MS = 5 * 1000;
// XXX: Another idea is to add some gain to the DAM videos?
const DAM_GAIN = 1.0;
const NON_DAM_GAIN = 0.8;

function Player(props: {
  mics: InputDevice[];
  kuroshiro: KuroshiroSingleton;
  audio: KarafriendsAudio;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLTrackElement>(null);
  const [scoringData, setScoringData] = useState<readonly number[]>([]);

  const [joysoundTelop, setJoysoundTelop] = useState<ArrayBuffer | null>(null);
  const [shouldShowJoysound, setShouldShowJoysound] = useState<boolean>(false);
  const [joysoundIsRomaji, setJoysoundIsRomaji] = useState<boolean>(false);

  const [shouldShowPianoRoll, setShouldShowPianoRoll] = useState<boolean>(true);
  const [shouldShowAdhocLyrics, setShouldShowAdhocLyrics] =
    useState<boolean>(false);
  const { playbackState, setPlaybackState } = usePlaybackState();
  const { pitchShiftSemis, setPitchShiftSemis } = usePitchShiftSemis();
  const pollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const audioCtx = useRef<AudioContext | null>(null);
  const videoAudioSrc = useRef<MediaElementAudioSourceNode | null>(null);

  let hls: Hls | null = null;

  useEffect(() => {
    if (!videoRef.current) return;

    const pollQueue = () =>
      commitMutation<PlayerPopSongMutation>(environment, {
        mutation: popSongMutation,
        variables: {},
        onCompleted: ({ popSong }) => {
          if (!popSong) return;
          if (!videoRef.current) return;
          if (trackRef?.current) {
            trackRef.current.default = false;
            trackRef.current.removeAttribute("src");
          }

          setPitchShiftSemis(0);

          if (popSong !== null) {
            if (hls) hls.destroy();

            switch (popSong.__typename) {
              case "DamQueueItem":
                setShouldShowPianoRoll(true);
                setShouldShowJoysound(false);
                setShouldShowAdhocLyrics(false);
                setScoringData(popSong.scoringData);

                // If caching is on this means we'll be serving almost everything through /static
                // which seems kind of stupid, but whatever
                const fileUrl = `karafriends://${popSong.songId}-${popSong.streamingUrlIdx}.mp4`;

                const loadRemote = () => {
                  if (!videoRef.current) return;

                  hls = new Hls({ maxBufferLength: 90 /* seconds */ });
                  hls.attachMedia(videoRef.current);
                  hls.loadSource(
                    popSong.streamingUrls[popSong.streamingUrlIdx].url,
                  );
                };

                fetch(fileUrl, { method: "HEAD" })
                  .then((response) => {
                    // I can guarantee this does not happen
                    if (!videoRef.current) return;

                    if (response.ok) {
                      console.log(`Using local file for ${popSong.songId}`);
                      // This throws a random DOMException about load requests but it's probably fine
                      videoRef.current.src = fileUrl;
                    } else {
                      // Maybe it's not done downloading yet, or predownload is disabled
                      console.log(
                        `Local file for ${popSong.songId} doesn't seem available, using remote`,
                      );
                      loadRemote();
                    }
                    props.audio.gain(DAM_GAIN);

                    navigator.mediaSession.metadata = new MediaMetadata({
                      title: popSong.name,
                      artist: popSong.artistName,
                    });

                    videoRef.current.play();
                  })
                  .catch((error) => {
                    // This throws if the file doesn't exist (as karafriends:// is a file:// passthrough protocol)
                    console.log(
                      `Local file for ${popSong.songId} doesn't seem available, using remote`,
                    );
                    console.error(error);

                    // I can guarantee this does not happen
                    if (!videoRef.current) return;

                    // Pretend nothing happened.
                    loadRemote();

                    props.audio.gain(DAM_GAIN);

                    navigator.mediaSession.metadata = new MediaMetadata({
                      title: popSong.name,
                      artist: popSong.artistName,
                    });

                    videoRef.current.play();
                  });
                break;
              case "JoysoundQueueItem":
                setShouldShowPianoRoll(false);
                setShouldShowJoysound(true);
                setShouldShowAdhocLyrics(false);

                const filenameSuffix = popSong.youtubeVideoId
                  ? popSong.youtubeVideoId
                  : "default";

                videoRef.current.src = `karafriends://joysound-${popSong.songId}-${filenameSuffix}.mp4`;

                navigator.mediaSession.metadata = new MediaMetadata({
                  title: popSong.name,
                  artist: popSong.artistName,
                });

                fetch(`karafriends://joysound-${popSong.songId}.joy_02`)
                  .then((resp) => resp.arrayBuffer())
                  .then((data) => {
                    setJoysoundTelop(data);
                    setJoysoundIsRomaji(popSong.isRomaji);

                    invariant(videoRef.current);
                    videoRef.current.play();
                  });

                break;
              case "YoutubeQueueItem":
                setShouldShowPianoRoll(false);
                setShouldShowJoysound(false);
                setShouldShowAdhocLyrics(popSong.hasAdhocLyrics);

                videoRef.current.src = `karafriends://yt-${popSong.songId}.mp4`;

                if (trackRef?.current && popSong?.hasCaptions) {
                  trackRef.current.default = true;
                  trackRef.current.src = `karafriends://yt-${popSong.songId}.vtt`;
                }

                console.log(
                  `Using ${popSong.gainValue} for gain on Youtube queue item`,
                );
                props.audio.gain(popSong.gainValue);

                navigator.mediaSession.metadata = new MediaMetadata({
                  title: popSong.name,
                });

                videoRef.current.play();
                break;
              case "NicoQueueItem":
                setShouldShowPianoRoll(false);
                setShouldShowJoysound(false);
                setShouldShowAdhocLyrics(false);

                videoRef.current.src = `karafriends://nico-${popSong.songId}.mp4`;

                props.audio.gain(NON_DAM_GAIN);

                navigator.mediaSession.metadata = new MediaMetadata({
                  title: popSong.name,
                });

                videoRef.current.play();
                break;
            }
            setPlaybackState("PLAYING");
          } else {
            setPlaybackState("WAITING");
            pollTimeoutRef.current = setTimeout(pollQueue, POLL_INTERVAL_MS);
          }
        },
      });

    videoRef.current.onended = pollQueue;

    if (playbackState === "WAITING" && pollTimeoutRef.current === null) {
      pollTimeoutRef.current = setTimeout(pollQueue, POLL_INTERVAL_MS);
    }

    return () => {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);

        pollTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!videoRef.current) return;

    switch (playbackState) {
      case "PAUSED":
        videoRef.current.pause();
        break;
      case "PLAYING":
        videoRef.current.play();
        break;
      case "RESTARTING":
        videoRef.current.currentTime = 0;
        setPlaybackState("PLAYING");
        break;
      case "SKIPPING":
        if (isFinite(videoRef.current.duration))
          videoRef.current.currentTime = videoRef.current.duration;
        videoRef.current.play();
        break;
    }
  }, [playbackState]);

  useEffect(() => {
    props.audio.pitchShift(pitchShiftSemis);
  }, [props.audio, pitchShiftSemis]);

  useEffect(() => {
    if (!videoRef.current) return;

    if (audioCtx.current !== props.audio.audioContext) {
      if (videoAudioSrc.current) {
        videoAudioSrc.current.disconnect();
      }

      audioCtx.current = props.audio.audioContext;
      videoAudioSrc.current = audioCtx.current.createMediaElementSource(
        videoRef.current,
      );
      videoAudioSrc.current.connect(props.audio.sink());
    }
  }, [props.audio, videoRef.current]);

  return (
    <div className="karaVidContainer">
      {shouldShowJoysound && joysoundTelop !== null ? (
        <JoysoundRenderer
          telop={joysoundTelop}
          isRomaji={joysoundIsRomaji}
          kuroshiro={props.kuroshiro}
          videoRef={videoRef}
        />
      ) : null}
      {shouldShowPianoRoll ? (
        <PianoRoll
          scoringData={scoringData}
          videoRef={videoRef}
          mics={props.mics}
          pitchShiftSemis={pitchShiftSemis}
        />
      ) : null}
      <video
        className="karaVid"
        ref={videoRef}
        crossOrigin="anonymous"
        controls
        controlsList="nodownload noplaybackrate"
        disablePictureInPicture
      >
        <track ref={trackRef} kind="subtitles" src="" default />
      </video>
      {shouldShowAdhocLyrics ? <AdhocLyrics /> : null}
    </div>
  );
}

export default Player;
