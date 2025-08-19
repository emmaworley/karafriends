import { spawn } from "child_process";
import { app } from "electron"; // tslint:disable-line:no-implicit-dependencies
import fs from "fs";
import process from "process";

import invariant from "ts-invariant";

import {
  DownloadQueueItem,
  JoysoundQueueItem,
  QueueSongResult,
  UserIdentity,
} from "../main/graphql";
import { JoysoundAPI, JoysoundSongRawData } from "../main/joysoundApi";

import { getSongDuration } from "./joysoundParser";

export const TEMP_FOLDER: string = `${app.getPath("temp")}/karafriends_tmp`;
const captionCodeRe: RegExp = new RegExp(/^[a-z]{2}$/);

console.log("Temp Folder: ");
console.log(TEMP_FOLDER);

const extraResourcesPath: string =
  process.env.NODE_ENV === "development"
    ? `${app.getAppPath()}/../../../extraResources/`
    : `${process.resourcesPath}/extraResources/`;

interface ResourcePaths {
  // Path to the directory containing the ffmpeg executable
  ffmpeg: string;
  // Path to the ytdlp executable
  ytdlp: string;
}

interface JoysoundVideoData {
  songId: string;
  songDuration: number;
  songPlaytime: number;
  videoPlaytime: number;
  oggBuffer: Buffer;
}

const linuxResourcePaths: ResourcePaths = {
  ffmpeg: `${extraResourcesPath}ffmpeg/linux/ffmpeg`,
  ytdlp: `${extraResourcesPath}/ytdlp/yt-dlp`,
};

const macosResourcePaths: ResourcePaths = {
  ffmpeg: `${extraResourcesPath}ffmpeg/macos/ffmpeg`,
  ytdlp: `${extraResourcesPath}ytdlp/yt-dlp_macos`,
};

const winResourcePaths: ResourcePaths = {
  ffmpeg: `${extraResourcesPath}ffmpeg/win/ffmpeg.exe`,
  ytdlp: `${extraResourcesPath}ytdlp/yt-dlp.exe`,
};

const resourcePaths: ResourcePaths =
  process.platform === "win32"
    ? winResourcePaths
    : process.platform === "darwin"
      ? macosResourcePaths
      : linuxResourcePaths;

function deleteTempFiles(prefix: string): void {
  for (const filename of fs.readdirSync(TEMP_FOLDER)) {
    if (!filename) {
      continue;
    }

    if (filename.includes(prefix)) {
      fs.unlinkSync(filename);
    }
  }
}

function handleFFmpegDownloadLog(
  log: string,
  songFrames: number,
  downloadQueueItem: DownloadQueueItem,
): void {
  const frameMatchData = log.match(/frame=\s*(\d+)\s*/);

  if (frameMatchData) {
    const rawProgress = parseInt(frameMatchData[1], 10) / songFrames;
    const progress = Math.min(rawProgress, 1.0);

    downloadQueueItem.progress = Math.max(downloadQueueItem.progress, progress);
  }
}

function handleYoutubeDownloadLog(
  log: string,
  downloadQueueItem: DownloadQueueItem,
): void {
  const matchData = log.match(/\[download\]\s*(\d+\.\d)%/);

  if (matchData) {
    const progress = Math.min(parseFloat(matchData[1]) / 100.0, 1.0);

    downloadQueueItem.progress = Math.max(downloadQueueItem.progress, progress);
  }
}

function isVideoCurrentlyDownloading(
  filename: string,
  downloadQueue: DownloadQueueItem[],
  downloadType: number,
  songId: string,
  suffix: string | null = null,
): boolean {
  if (!fs.existsSync(filename)) {
    return false;
  }

  const prevDownloadQueueItem = downloadQueue.find(
    (item) =>
      item.downloadType === downloadType &&
      item.songId === songId &&
      item.suffix === suffix,
  );

  return Boolean(prevDownloadQueueItem);
}

export function getVideoDownloadProgress(
  downloadQueue: DownloadQueueItem[],
  downloadType: number,
  songId: string,
  suffix: string | null = null,
): number {
  const downloadQueueItem = downloadQueue.find(
    (item) =>
      item.downloadType === downloadType &&
      item.songId === songId &&
      item.suffix === suffix,
  );

  if (downloadQueueItem) {
    return downloadQueueItem.progress;
  }

  return -1.0;
}

function removeVideoDownloadFromQueue(
  downloadQueue: DownloadQueueItem[],
  downloadQueueItem: DownloadQueueItem,
): void {
  downloadQueue.splice(downloadQueue.indexOf(downloadQueueItem), 1);
}

function getJoysoundOggPlaytime(oggBuffer: Buffer): number {
  const FIELD_TAG = new Uint8Array([
    0x70, 0x6c, 0x61, 0x79, 0x74, 0x69, 0x6d, 0x65, 0x3d,
  ]);

  let fieldOffset = 0;
  let fieldLength = 0;

  for (let i = 0; i < oggBuffer.length; i++) {
    const oggSlice = oggBuffer.subarray(i, i + FIELD_TAG.length);

    let isFieldTag = true;

    for (let j = 0; j < oggSlice.length; j++) {
      if (oggSlice[j] !== FIELD_TAG[j]) {
        isFieldTag = false;
        break;
      }
    }

    if (!isFieldTag) {
      continue;
    }

    fieldOffset = i + FIELD_TAG.length;

    const fieldLengthView = new DataView(oggBuffer.buffer, i - 4, 4);
    fieldLength = fieldLengthView.getUint32(0, true) - FIELD_TAG.length;

    break;
  }

  const playtimeBuffer = oggBuffer.subarray(
    fieldOffset,
    fieldOffset + fieldLength,
  );

  let playtimeString = "";

  for (const char of playtimeBuffer) {
    playtimeString += String.fromCharCode(char);
  }

  return parseInt(playtimeString, 10);
}

export function downloadDamVideo(
  m3u8Url: string,
  songId: string,
  suffix: string,
): void {
  if (!fs.existsSync(TEMP_FOLDER)) {
    fs.mkdirSync(TEMP_FOLDER);
  }

  const filename = `${TEMP_FOLDER}/${songId}-${suffix}.mp4`;
  const tempFilename = `${filename}.tmp`;

  if (fs.existsSync(filename)) {
    console.info(`${filename} already exists, not redownloading`);
    return;
  }

  console.info(`Downloading DAM video to ${filename}`);

  const ffmpegLogFilename = `${TEMP_FOLDER}/dam-${songId}.log`;
  const ffmpegLogStream = fs.createWriteStream(ffmpegLogFilename);

  const ffmpeg = spawn(
    resourcePaths.ffmpeg,
    [
      "-y",
      "-i",
      m3u8Url,
      "-c",
      "copy",
      "-movflags",
      "faststart",
      "-f",
      "mp4",
      tempFilename,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  invariant(ffmpeg.stdout);
  invariant(ffmpeg.stderr);
  ffmpeg.stdout.pipe(process.stdout);
  ffmpeg.stdout.pipe(ffmpegLogStream);
  ffmpeg.stderr.pipe(process.stderr);
  ffmpeg.stderr.pipe(ffmpegLogStream);

  ffmpeg.on("exit", (code, signal) => {
    if (code === 0) {
      fs.renameSync(tempFilename, filename);
    } else {
      console.error(
        `Error downloading DAM video with ID ${songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
      );
    }
  });
}

function makeJoysoundFFmpegCall(
  songId: string,
  ffmpegArgs: string[],
  ffmpegLogFilename: string,
  onStderrData: null | ((data: Buffer) => any),
  onExit: null | ((code: number, signal: number) => any),
  stdinBuffer: Buffer | string | null,
): void {
  const ffmpegLogStream = fs.createWriteStream(ffmpegLogFilename, {
    flags: "a",
  });

  const ffmpeg = spawn(resourcePaths.ffmpeg, ffmpegArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  invariant(ffmpeg.stdin);
  invariant(ffmpeg.stdout);
  invariant(ffmpeg.stderr);

  ffmpeg.stdout.pipe(process.stdout);
  ffmpeg.stdout.pipe(ffmpegLogStream);
  ffmpeg.stderr.pipe(process.stderr);
  ffmpeg.stderr.pipe(ffmpegLogStream);

  if (onStderrData) {
    ffmpeg.stderr.on("data", onStderrData);
  }

  if (onExit) {
    ffmpeg.on("exit", onExit);
  }

  if (stdinBuffer) {
    ffmpeg.stdin.write(stdinBuffer);
    ffmpeg.stdin.end();
  }
}

function downloadJoysoundVideoPromise(
  songId: string,
  videoUrl: string,
  downloadQueue: DownloadQueueItem[],
  downloadQueueItem: DownloadQueueItem,
  tempFilename: string,
  ffmpegLogFilename: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let songFrames = 0;

    const ffmpegArgs = [
      "-i",
      videoUrl,
      "-c",
      "copy",
      "-movflags",
      "faststart",
      "-f",
      "mp4",
      "-y",
      tempFilename,
    ];

    const onStderrData = (ffmpegData: Buffer) => {
      const ffmpegLog = ffmpegData.toString();

      const durationMatchData = ffmpegLog.match(
        /Duration:\s*(\d+):(\d+):(\d+)/,
      );

      if (durationMatchData) {
        let songDuration = 0;

        songDuration += parseInt(durationMatchData[1], 10) * 3600;
        songDuration += parseInt(durationMatchData[2], 10) * 60;
        songDuration += parseInt(durationMatchData[3], 10);

        songFrames = songDuration * 30;
      }

      handleFFmpegDownloadLog(ffmpegLog, songFrames, downloadQueueItem);
    };

    const onExit = (code: number, signal: number) => {
      if (code === 0) {
        removeVideoDownloadFromQueue(downloadQueue, downloadQueueItem);

        resolve(code);
      } else {
        console.error(
          `Error downloading Joysound video with ID ${songId}: url=${videoUrl}, code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
        );

        reject(code);
      }
    };

    makeJoysoundFFmpegCall(
      songId,
      ffmpegArgs,
      ffmpegLogFilename,
      onStderrData,
      onExit,
      null,
    );
  });
}

function downloadJoysoundYoutubeVideoPromise(
  songId: string,
  youtubeVideoId: string,
  downloadQueue: DownloadQueueItem[],
  downloadQueueItem: DownloadQueueItem,
  tempFilename: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ytdlpLogFilename = `${TEMP_FOLDER}/yt-${youtubeVideoId}.log`;
    const ytdlpLogStream = fs.createWriteStream(ytdlpLogFilename);

    const env = { ...process.env };
    // Don't need a proxy to download from YouTube
    delete process.env.http_proxy;

    const ytdlpFlags: string[] = [
      "-S",
      "res:720,ext:mp4",
      "-f",
      "bv",
      "--recode",
      "mp4",
      "-N",
      "4",
      "--ffmpeg-location",
      resourcePaths.ffmpeg,
      "-o",
      tempFilename + ".mp4",
      "--",
      youtubeVideoId!,
    ];

    const ytdlp = spawn(resourcePaths.ytdlp, ytdlpFlags, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    console.log("Running Shell Command: yt-dlp " + ytdlpFlags.join(" "));

    invariant(ytdlp.stdout);
    invariant(ytdlp.stderr);

    ytdlp.stdout.pipe(process.stdout);
    ytdlp.stdout.pipe(ytdlpLogStream);
    ytdlp.stderr.pipe(process.stderr);
    ytdlp.stderr.pipe(ytdlpLogStream);

    ytdlp.stdout.on("data", (data) => {
      handleYoutubeDownloadLog(data.toString(), downloadQueueItem);
    });

    ytdlp.on("exit", (code, signal) => {
      if (code === 0) {
        fs.unlinkSync(tempFilename);
        fs.renameSync(tempFilename + ".mp4", tempFilename);

        removeVideoDownloadFromQueue(downloadQueue, downloadQueueItem);

        resolve(code);
      } else {
        console.error(
          `Error downloading Youtube Video with ID ${youtubeVideoId}: code=${code}, signal=${signal}, log=${ytdlpLogFilename}`,
        );
        reject(code);
      }
    });
  });
}

function composeJoysoundVideoPromise(
  songId: string,
  telopBuffer: Buffer,
  oggBuffer: Buffer,
  tempFilename: string,
  videoFilename: string,
  ffmpegLogFilename: string,
): Promise<JoysoundVideoData> {
  return new Promise((resolve, reject) => {
    let videoPlaytime = 0;

    const ffmpegArgs = [
      "-stream_loop",
      "-1",
      "-i",
      tempFilename,
      "-i",
      "-",
      "-c",
      "copy",
      "-shortest",
      "-movflags",
      "faststart",
      "-f",
      "mp4",
      videoFilename,
    ];

    const onStderrData = (ffmpegData: Buffer) => {
      const ffmpegLog = ffmpegData.toString();

      const durationMatchData = ffmpegLog.match(
        /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/,
      );

      // XXX: We assume that the video duration always comes first
      if (durationMatchData && videoPlaytime === 0) {
        videoPlaytime += parseInt(durationMatchData[1], 10) * 3600;
        videoPlaytime += parseInt(durationMatchData[2], 10) * 60;
        videoPlaytime += parseInt(durationMatchData[3], 10);
        videoPlaytime =
          videoPlaytime * 1000 + parseInt(durationMatchData[4], 10) * 10;
      }
    };

    const onExit = (code: number, signal: number) => {
      fs.unlinkSync(tempFilename);

      if (code === 0) {
        const metadata: JoysoundVideoData = {
          songDuration: getSongDuration(telopBuffer.buffer) * 1000,
          songPlaytime: getJoysoundOggPlaytime(oggBuffer),
          songId,
          oggBuffer,
          videoPlaytime,
        };

        resolve(metadata);
      } else {
        console.error(
          `Error downloading Joysound video with ID ${songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
        );

        reject(code);
      }
    };

    makeJoysoundFFmpegCall(
      songId,
      ffmpegArgs,
      ffmpegLogFilename,
      onStderrData,
      onExit,
      oggBuffer,
    );
  });
}

function padJoysoundVideoPromise(
  data: JoysoundVideoData,
  videoFilename: string,
  ffmpegLogFilename: string,
  queueItem: JoysoundQueueItem,
  pushToHead: boolean,
  pushSongToQueue: (
    queueItem: JoysoundQueueItem,
    pushToHead: boolean,
  ) => QueueSongResult,
): Promise<number> {
  const videoBaseFilename = videoFilename.substr(0, videoFilename.length - 4);

  const videoNoSoundFilename = videoBaseFilename + "-no-sound.mp4";
  const videoPadFrameFilename = videoBaseFilename + "-pad-1f.mp4";
  const videoPadFilename = videoBaseFilename + "-pad.mp4";
  const videoConcatFilename = videoBaseFilename + "-concat.mp4";
  const videoTempFilename = videoBaseFilename + "-temp.mp4";
  const videoOutFilename = videoBaseFilename + "-out.mp4";
  const videoListFilename = videoBaseFilename + "-list.txt";

  return new Promise<number>((resolve, reject) => {
    const ffmpegArgs = [
      "-i",
      videoFilename,
      "-c",
      "copy",
      "-an",
      "-y",
      videoNoSoundFilename,
    ];

    const onExit = (code: number, signal: number) => {
      if (code === 0) {
        resolve(code);
      } else {
        console.error(
          `Error downloading Joysound video with ID ${data.songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
        );

        reject(code);
      }
    };

    makeJoysoundFFmpegCall(
      data.songId,
      ffmpegArgs,
      ffmpegLogFilename,
      null,
      onExit,
      null,
    );
  })
    .then(() => {
      return new Promise<number>((resolve, reject) => {
        const ffmpegArgs = [
          "-i",
          videoNoSoundFilename,
          "-frames:v",
          "1",
          "-c:v",
          "copy",
          "-an",
          "-y",
          videoPadFrameFilename,
        ];

        const onExit = (code: number, signal: number) => {
          if (code === 0) {
            resolve(code);
          } else {
            console.error(
              `Error downloading Joysound video with ID ${data.songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
            );

            reject(code);
          }
        };

        makeJoysoundFFmpegCall(
          data.songId,
          ffmpegArgs,
          ffmpegLogFilename,
          null,
          onExit,
          null,
        );
      });
    })
    .then(() => {
      return new Promise<number>((resolve, reject) => {
        const offset = Math.max(data.songPlaytime - data.videoPlaytime, 0);

        const ffmpegArgs = [
          "-stream_loop",
          "-1",
          "-i",
          videoPadFrameFilename,
          "-c",
          "copy",
          "-t",
          `${offset}ms`,
          "-y",
          videoPadFilename,
        ];

        const onExit = (code: number, signal: number) => {
          if (code === 0) {
            resolve(code);
          } else {
            console.error(
              `Error downloading Joysound video with ID ${data.songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
            );

            reject(code);
          }
        };

        makeJoysoundFFmpegCall(
          data.songId,
          ffmpegArgs,
          ffmpegLogFilename,
          null,
          onExit,
          null,
        );
      });
    })
    .then(() => {
      return new Promise<number>((resolve, reject) => {
        let listFile = "";

        listFile += `file '${videoPadFilename.replace(/\\/g, "/")}'`;
        listFile += "\n";
        listFile += `file '${videoNoSoundFilename.replace(/\\/g, "/")}'`;

        fs.writeFileSync(videoListFilename, listFile);

        const ffmpegArgs = [
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          videoListFilename,
          "-c",
          "copy",
          "-y",
          videoConcatFilename,
        ];

        const onExit = (code: number, signal: number) => {
          if (code === 0) {
            resolve(code);
          } else {
            console.error(
              `Error downloading Joysound video with ID ${data.songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
            );

            reject(code);
          }
        };

        makeJoysoundFFmpegCall(
          data.songId,
          ffmpegArgs,
          ffmpegLogFilename,
          null,
          onExit,
          null,
        );
      });
    })
    .then(() => {
      return new Promise<number>((resolve, reject) => {
        const ffmpegArgs = [
          "-i",
          videoFilename,
          "-i",
          videoConcatFilename,
          "-map",
          "0:a",
          "-map",
          "1:v",
          "-c",
          "copy",
          "-shortest",
          "-y",
          videoOutFilename,
        ];

        const onExit = (code: number, signal: number) => {
          if (code === 0) {
            fs.renameSync(videoFilename, videoTempFilename);
            fs.renameSync(videoOutFilename, videoFilename);

            fs.unlinkSync(videoNoSoundFilename);
            fs.unlinkSync(videoPadFrameFilename);
            fs.unlinkSync(videoPadFilename);
            fs.unlinkSync(videoTempFilename);
            fs.unlinkSync(videoConcatFilename);

            pushSongToQueue(queueItem, pushToHead);

            resolve(code);
          } else {
            console.error(
              `Error downloading Joysound video with ID ${data.songId}: code=${code}, signal=${signal}, log=${ffmpegLogFilename}`,
            );

            reject(code);
          }
        };

        makeJoysoundFFmpegCall(
          data.songId,
          ffmpegArgs,
          ffmpegLogFilename,
          null,
          onExit,
          null,
        );
      });
    });
}

export function downloadJoysoundData(
  downloadQueue: DownloadQueueItem[],
  userIdentity: UserIdentity,
  joysoundApi: JoysoundAPI,
  queueItem: JoysoundQueueItem,
  pushToHead: boolean,
  pushSongToQueue: (
    queueItem: JoysoundQueueItem,
    pushToHead: boolean,
  ) => QueueSongResult,
): void {
  if (!fs.existsSync(TEMP_FOLDER)) {
    fs.mkdirSync(TEMP_FOLDER);
  }

  const songId = queueItem.songId;

  const videoFilenameSuffix = queueItem.youtubeVideoId
    ? queueItem.youtubeVideoId
    : "default";

  const filenamePrefix = `joysound-${songId}`;
  const writeBasePath = `${TEMP_FOLDER}/${filenamePrefix}`;

  const telopFilename = `${writeBasePath}.joy_02`;
  const videoFilename = `${writeBasePath}-${videoFilenameSuffix}.mp4`;
  const ffmpegLogFilename = `${writeBasePath}.log`;

  const tempFilename = `${videoFilename}.tmp`;

  if (fs.existsSync(videoFilename)) {
    console.info(`${videoFilename} already exists, not redownloading`);

    if (fs.existsSync(telopFilename)) {
      const telopBuffer = fs.readFileSync(telopFilename);

      queueItem = {
        ...queueItem,
        playtime: getSongDuration(telopBuffer.buffer),
      };

      pushSongToQueue(queueItem, pushToHead);
      return;
    } else {
      console.error(
        `${videoFilename} already exists, but ${telopFilename} does not.`,
      );

      fs.unlinkSync(videoFilename);
    }
  }

  if (
    isVideoCurrentlyDownloading(
      tempFilename,
      downloadQueue,
      0,
      songId,
      queueItem.youtubeVideoId,
    )
  ) {
    console.error(`${videoFilename} was already queued, not redownloading`);

    return;
  } else if (fs.existsSync(tempFilename)) {
    console.error(`${tempFilename} exists but was not in the download queue.`);

    deleteTempFiles(filenamePrefix);
  }

  fs.closeSync(fs.openSync(tempFilename, "w"));

  const downloadQueueItem: DownloadQueueItem = {
    downloadType: 0,
    userIdentity,
    songId,
    suffix: queueItem.youtubeVideoId,
    progress: 0.0,
  };

  downloadQueue.push(downloadQueueItem);

  const songDataPromise = joysoundApi.getSongRawData(songId);
  let videoDataPromise;

  if (queueItem.youtubeVideoId) {
    videoDataPromise = downloadJoysoundYoutubeVideoPromise(
      songId,
      queueItem.youtubeVideoId,
      downloadQueue,
      downloadQueueItem,
      tempFilename,
    );
  } else {
    videoDataPromise = joysoundApi.getMovieUrls(songId).then((data) => {
      const videoUrl = data.movie.mov1;

      return downloadJoysoundVideoPromise(
        songId,
        videoUrl,
        downloadQueue,
        downloadQueueItem,
        tempFilename,
        ffmpegLogFilename,
      );
    });
  }

  console.info(`Downloading Joysound video to ${videoFilename}`);

  Promise.all([videoDataPromise, songDataPromise])
    .then((values) => {
      const joysoundSongRawData = values[1];

      const telopBase64 = joysoundSongRawData.telop;
      const oggBase64 = joysoundSongRawData.ogg;

      const telopBuffer = Buffer.from(
        telopBase64.slice(30) + telopBase64.slice(0, 30),
        "base64",
      );

      const oggBuffer = Buffer.from(
        oggBase64.slice(30) + oggBase64.slice(0, 30),
        "base64",
      );

      if (!fs.existsSync(telopFilename)) {
        fs.writeFileSync(telopFilename, telopBuffer);
      }

      return composeJoysoundVideoPromise(
        songId,
        telopBuffer,
        oggBuffer,
        tempFilename,
        videoFilename,
        ffmpegLogFilename,
      );
    })
    .then((data) => {
      queueItem = {
        ...queueItem,
        playtime: Math.floor(data.songPlaytime / 1000),
      };

      if (
        queueItem.youtubeVideoId &&
        Math.abs(data.songDuration - data.videoPlaytime) < 10000
      ) {
        return padJoysoundVideoPromise(
          data,
          videoFilename,
          ffmpegLogFilename,
          queueItem,
          pushToHead,
          pushSongToQueue,
        );
      } else {
        pushSongToQueue(queueItem, pushToHead);
      }
    });
}

export function downloadYoutubeVideo(
  downloadQueue: DownloadQueueItem[],
  userIdentity: UserIdentity,
  videoId: string,
  captionCode: string | null,
  onComplete: () => any,
): void {
  if (captionCode !== null && !captionCodeRe.test(captionCode)) {
    console.error(
      `Error downloading Youtube Video. ${captionCode} is not a valid caption code`,
    );
    return;
  }

  if (!fs.existsSync(TEMP_FOLDER)) {
    fs.mkdirSync(TEMP_FOLDER);
  }

  const filenamePrefix = `yt-${videoId}`;
  const writeBasePath = `${TEMP_FOLDER}/${filenamePrefix}`;

  const videoFilename = `${writeBasePath}.mp4`;
  const vttFilename = `${writeBasePath}.vtt`;
  const ytdlpLogFilename = `${writeBasePath}.log`;

  if (fs.existsSync(videoFilename)) {
    console.log("YT video with filename already exists.");
    console.log(videoFilename);
    console.log(vttFilename);
    onComplete();
    return;
  }

  const tempFilename = `${videoFilename}.tmp`;

  if (isVideoCurrentlyDownloading(tempFilename, downloadQueue, 1, videoId)) {
    console.error(`${videoFilename} was already queued, not redownloading`);

    return;
  } else if (fs.existsSync(tempFilename)) {
    console.error(`${tempFilename} exists but was not in the download queue.`);

    deleteTempFiles(filenamePrefix);
  }

  fs.closeSync(fs.openSync(tempFilename, "w"));

  const downloadQueueItem: DownloadQueueItem = {
    downloadType: 1,
    userIdentity,
    songId: videoId,
    suffix: null,
    progress: 0.0,
  };

  downloadQueue.push(downloadQueueItem);

  console.info(`Downloading YouTube video to ${videoFilename}`);

  const ytdlpLogStream = fs.createWriteStream(ytdlpLogFilename);

  const captionArgs = captionCode
    ? ["--write-subs", "--sub-langs", captionCode]
    : [];

  const ytdlpFlags = [
    ...captionArgs,
    "-S",
    "res:720,ext:mp4:m4a",
    "--recode",
    "mp4",
    "-N",
    "4",
    "--ffmpeg-location",
    resourcePaths.ffmpeg,
    "-o",
    `${videoFilename}`,
    "--",
    videoId,
  ];

  const ytdlp = spawn(resourcePaths.ytdlp, ytdlpFlags, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  console.log("Running Command: yt-dlp " + ytdlpFlags.join(" "));

  invariant(ytdlp.stdout);
  invariant(ytdlp.stderr);

  ytdlp.stdout.pipe(process.stdout);
  ytdlp.stdout.pipe(ytdlpLogStream);
  ytdlp.stderr.pipe(process.stderr);
  ytdlp.stderr.pipe(ytdlpLogStream);

  ytdlp.stdout.on("data", (data) => {
    handleYoutubeDownloadLog(data.toString(), downloadQueueItem);
  });

  ytdlp.on("exit", (code, signal) => {
    removeVideoDownloadFromQueue(downloadQueue, downloadQueueItem);

    fs.unlinkSync(tempFilename);

    if (code !== 0) {
      console.error(
        `Error downloading Youtube Video with ID ${videoId}: code=${code}, signal=${signal}, log=${ytdlpLogFilename}`,
      );
      return;
    }

    if (captionCode) {
      try {
        fs.renameSync(`${writeBasePath}.${captionCode}.vtt`, vttFilename);
      } catch (fsError) {
        console.error(
          `Error trying to rename caption file ${writeBasePath}.${captionCode}.vtt to ${writeBasePath}.vtt: ${fsError}`,
        );
      }
    }

    onComplete();
  });
}

export function downloadNicoVideo(
  downloadQueue: DownloadQueueItem[],
  userIdentity: UserIdentity,
  videoId: string,
  onComplete: () => any,
): void {
  if (!fs.existsSync(TEMP_FOLDER)) {
    fs.mkdirSync(TEMP_FOLDER);
  }

  const filenamePrefix = `nico-${videoId}`;
  const writeBasePath = `${TEMP_FOLDER}/${filenamePrefix}`;

  const videoFilename = `${writeBasePath}.mp4`;
  const ytdlpLogFilename = `${writeBasePath}.log`;

  const tempFilename = `${videoFilename}.tmp`;

  if (isVideoCurrentlyDownloading(tempFilename, downloadQueue, 2, videoId)) {
    console.error(`${videoFilename} was already queued, not redownloading`);

    return;
  } else if (fs.existsSync(tempFilename)) {
    console.error(`${tempFilename} exists but was not in the download queue.`);

    deleteTempFiles(filenamePrefix);
  }

  fs.closeSync(fs.openSync(tempFilename, "w"));

  const downloadQueueItem: DownloadQueueItem = {
    downloadType: 2,
    userIdentity,
    songId: videoId,
    suffix: null,
    progress: 0.0,
  };

  downloadQueue.push(downloadQueueItem);

  console.info(`Downloading Niconico video to ${videoFilename}`);

  const ytdlpLogStream = fs.createWriteStream(ytdlpLogFilename);

  const env = { ...process.env };
  // Don't need a proxy to download from Niconico
  delete process.env.http_proxy;

  const ytdlp = spawn(
    resourcePaths.ytdlp,
    [
      "-N",
      "4",
      "-o",
      `${videoFilename}`,
      "--",
      `https://www.nicovideo.jp/watch/${videoId}`,
    ],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  invariant(ytdlp.stdout);
  invariant(ytdlp.stderr);

  ytdlp.stdout.pipe(process.stdout);
  ytdlp.stdout.pipe(ytdlpLogStream);
  ytdlp.stderr.pipe(process.stderr);
  ytdlp.stderr.pipe(ytdlpLogStream);

  ytdlp.stdout.on("data", (data) => {
    handleYoutubeDownloadLog(data.toString(), downloadQueueItem);
  });

  ytdlp.on("exit", (code, signal) => {
    removeVideoDownloadFromQueue(downloadQueue, downloadQueueItem);

    fs.unlinkSync(tempFilename);

    if (code === 0) {
      onComplete();
    } else {
      console.error(
        `Error downloading Niconico Video with ID ${videoId}: code=${code}, signal=${signal}, log=${ytdlpLogFilename}`,
      );
    }
  });
}
