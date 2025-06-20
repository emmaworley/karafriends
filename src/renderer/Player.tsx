import invariant from "ts-invariant";

import Hls from "hls.js";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { commitMutation, graphql, useSubscription } from "react-relay";
import { PlayerPopSongMutation } from "./__generated__/PlayerPopSongMutation.graphql";
import { PlayerQueueAddedSubscription } from "./__generated__/PlayerQueueAddedSubscription.graphql";

import environment from "../common/graphqlEnvironment";
import usePitchShiftSemis from "../common/hooks/usePitchShiftSemis";
import usePlaybackState from "../common/hooks/usePlaybackState";
import parseJoysoundData, {
  KuroshiroSingleton,
  LyricsData,
} from "../common/joysoundParser";
import parseVtt from "../common/vttParser";
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
        captionCode
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

const songAddedSubscription = graphql`
  subscription PlayerQueueAddedSubscription {
    queueAdded {
      ... on QueueItemInterface {
        songId
      }
    }
  }
`;

// XXX: Another idea is to add some gain to the DAM videos?
const DAM_GAIN = 1.0;
const NON_DAM_GAIN = 0.8;

function Player(props: {
  mics: InputDevice[];
  kuroshiro: KuroshiroSingleton;
  audio: KarafriendsAudio;
}) {
  let isInitialRender = true;

  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLTrackElement>(null);
  const [scoringData, setScoringData] = useState<readonly number[]>([]);

  const [rendererLyricsData, setRendererLyricsData] =
    useState<LyricsData | null>(null);
  const [shouldShowJoysound, setShouldShowJoysound] = useState<boolean>(false);
  const [joysoundIsRomaji, setJoysoundIsRomaji] = useState<boolean>(false);

  const [shouldShowPianoRoll, setShouldShowPianoRoll] = useState<boolean>(true);
  const [shouldShowAdhocLyrics, setShouldShowAdhocLyrics] =
    useState<boolean>(false);
  const { playbackState, setPlaybackState } = usePlaybackState();
  const { pitchShiftSemis, setPitchShiftSemis } = usePitchShiftSemis();

  const audioCtx = useRef<AudioContext | null>(null);
  const videoAudioSrc = useRef<MediaElementAudioSourceNode | null>(null);

  let hls: Hls | null = null;

  const popSongFromQueue = () => {
    commitMutation<PlayerPopSongMutation>(environment, {
      mutation: popSongMutation,
      variables: {},
      onCompleted: ({ popSong }) => {
        console.log("popSongFromQueue");
        console.log(popSong);

        if (!popSong) return;
        if (!videoRef.current) return;

        if (trackRef?.current) {
          trackRef.current.default = false;
          trackRef.current.src = "";
        }

        setPitchShiftSemis(0);

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
              .then((data) => parseJoysoundData(data, props.kuroshiro))
              .then((lyricsData) => {
                setRendererLyricsData(lyricsData);
                setJoysoundIsRomaji(popSong.isRomaji);

                invariant(videoRef.current);
                videoRef.current.play();
              });

            break;
          case "YoutubeQueueItem":
            setShouldShowPianoRoll(false);
            setShouldShowJoysound(popSong?.hasCaptions);
            setShouldShowAdhocLyrics(popSong.hasAdhocLyrics);

            videoRef.current.src = `karafriends://yt-${popSong.songId}.mp4`;

            console.log(
              `Using ${popSong.gainValue} for gain on Youtube queue item`,
            );
            props.audio.gain(popSong.gainValue);

            navigator.mediaSession.metadata = new MediaMetadata({
              title: popSong.name,
            });

            if (popSong?.hasCaptions) {
              // If a song has captions then it must also have a captionCode
              invariant(popSong.captionCode);

              fetch(`karafriends://yt-${popSong.songId}.vtt`)
                .then((resp) => resp.text())
                .then((data) => parseVtt(data, popSong.captionCode as string))
                .then((lyricsData) => {
                  setRendererLyricsData(lyricsData);
                  // TODO: Romaji
                  // setJoysoundIsRomaji(popSong.isRomaji);

                  invariant(videoRef.current);
                  videoRef.current.play();
                });
            }

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
      },
    });
  };

  useSubscription<PlayerQueueAddedSubscription>(
    useMemo(
      () => ({
        variables: {},
        subscription: songAddedSubscription,
        onNext: (response) => {
          if (!response) {
            return;
          }

          if (!videoRef.current) {
            return;
          }

          if (videoRef.current.src.length === 0) {
            popSongFromQueue();
          }
        },
      }),
      [songAddedSubscription],
    ),
  );

  useEffect(() => {
    if (!isInitialRender) return;
    if (!videoRef.current) return;

    // At startup, db.currentSong is null. Replace with first song in queue if
    // queue is not empty.
    popSongFromQueue();

    isInitialRender = false;
  }, []);

  useEffect(() => {
    if (!videoRef.current) return;

    videoRef.current.onended = popSongFromQueue;
  }, [videoRef]);

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
      {shouldShowJoysound && rendererLyricsData !== null ? (
        <JoysoundRenderer
          lyricsData={rendererLyricsData}
          isRomaji={joysoundIsRomaji}
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
        controlsList="nodownload noplaybackrate nofullscreen"
        disablePictureInPicture
      ></video>
      {shouldShowAdhocLyrics ? <AdhocLyrics /> : null}
    </div>
  );
}

export default Player;
