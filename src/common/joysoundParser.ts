/* tslint:disable:no-bitwise */
import invariant from "ts-invariant";

import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer, { AnalyzerResult } from "kuroshiro-analyzer-kuromoji";

import { RUBY_FONT_SIZE, RUBY_FONT_STROKE } from "../common/constants";
import kanjiToReading from "./dictionary.json";

type DictionaryKanji = keyof typeof kanjiToReading;

export interface KuroshiroSingleton {
  kuroshiro: Kuroshiro;
  analyzer: KuromojiAnalyzer;
  analyzerInitPromise: Promise<void>;
}

export interface JoysoundPaletteColor {
  id: number;
  rgb: number[];
}

export interface JoysoundMetadata {
  musicName: string;
  artistName: string;
  lyricistName: string;
  composerName: string;
  musicNameReading: string;
  artistNameReading: string;
  fadeoutTime: number;
}

interface JoysoundLyricsChar {
  font: number;
  width: number;
  charCode: number;
  furiganaIndex: number;
}

interface JoysoundLyricsFurigana {
  length: number;
  xPos: number;
  chars: number[];
}

interface JoysoundLyricsRomaji {
  phrase: string;
  xPos: number;
  sourceWidth: number;
}

interface JoysoundScrollEvent {
  time: number;
  speed: number;
}

export interface JoysoundLyricsBlock {
  blockSize: number;
  flags: number;
  xPos: number;
  yPos: number;
  preFill: JoysoundPaletteColor;
  postFill: JoysoundPaletteColor;
  preBorder: JoysoundPaletteColor;
  postBorder: JoysoundPaletteColor;
  chars: JoysoundLyricsChar[];
  furigana: JoysoundLyricsFurigana[];
  romaji: JoysoundLyricsRomaji[];
  scrollEvents: JoysoundScrollEvent[];
  fadeinTime: number;
  fadeoutTime: number;
}

interface JoysoundTimelineEvent {
  currTime: number;
  payload: number[];
}

export interface JoysoundTelopData {
  metadata: JoysoundMetadata;
  lyrics: JoysoundLyricsBlock[];
  timeline: JoysoundTimelineEvent[];
}

const SUTEGANA = [
  "ぁ",
  "ぃ",
  "ぅ",
  "ぇ",
  "ぉ",
  "ゃ",
  "ゅ",
  "ょ",
  "ゎ",
  "ゕ",
  "ゖ",
];

const sjisDecoder = new TextDecoder("sjis");
const eucKrDecoder = new TextDecoder("euc-kr");

export function decodeJoysoundText(
  charCode: number,
  fontCode: number = 0,
  flags: number = 0,
): string {
  switch (fontCode) {
    case 0:
      return decodeSJIS(charCode, flags);
      break;
    case 1:
      return decodeEucKR(charCode);
      break;
    default:
      return decodeSJIS(charCode, flags);
  }
}

function decodeSJIS(charCode: number, flags: number): string {
  if (charCode <= 0xff) {
    return sjisDecoder.decode(new Uint8Array([charCode]));
  }

  if (flags === 255) {
    if (charCode === 0x819b) {
      return "♦";
    } else if (charCode === 0x819c) {
      return "♥";
    } else if (charCode === 0x819e) {
      return "♣";
    } else if (charCode === 0x819f) {
      return "♠";
    }
  }

  const bytes = new Uint8Array([Math.floor(charCode / 256), charCode % 256]);

  return sjisDecoder.decode(bytes);
}

function decodeEucKR(charCode: number): string {
  const bytes = new Uint8Array([Math.floor(charCode / 256), charCode % 256]);

  return eucKrDecoder.decode(bytes);
}

function isKatakanaUnicodeChar(unicodeChar: string) {
  const charCode = unicodeChar.charCodeAt(0);

  return charCode >= 0x30a0 && charCode <= 0x30ff;
}

function isKanaUnicodeChar(unicodeChar: string) {
  const charCode = unicodeChar.charCodeAt(0);

  return charCode >= 0x3040 && charCode <= 0x30ff;
}

function isKanjiUnicodeChar(unicodeChar: string) {
  return Kuroshiro.Util.hasKanji(unicodeChar) || unicodeChar === "々";
}

function kanaReadingToRomaji(kanaReading: string) {
  if (["ッ", "っ"].includes(kanaReading.slice(-1))) {
    return Kuroshiro.Util.kanaToRomaji(kanaReading.slice(0, -1), "hepburn");
  } else if (kanaReading === "ンー") {
    return "n";
  }

  return Kuroshiro.Util.kanaToRomaji(kanaReading, "hepburn");
}

function kanjiPhraseToRomaji(
  kanjiPhrase: string,
  hiraganaPhrase: string,
): string {
  if (kanjiToReading[kanjiPhrase as DictionaryKanji] !== undefined) {
    return kanaReadingToRomaji(kanjiToReading[kanjiPhrase as DictionaryKanji]);
  }

  return kanaReadingToRomaji(hiraganaPhrase);
}

function getRawLyrics(chars: JoysoundLyricsChar[]): string {
  let lyrics = "";

  for (const char of chars) {
    const unicodeChar = decodeJoysoundText(char.charCode, char.font);

    lyrics += unicodeChar;
  }

  return lyrics;
}

function getMainRomajiBlocks(
  chars: JoysoundLyricsChar[],
  tokenizedLyrics: AnalyzerResult[],
): JoysoundLyricsRomaji[] {
  const mainRomajiBlocks = [];

  let currXPos = 0;
  let currPhrase = "";
  let currPhraseWidth = 0;
  let prevGlyph = null;

  let tokenizedLyricsIndex = 0;
  let tokenizedLyricsCharIndex = 0;

  for (const currGlyph of chars) {
    const unicodeChar = decodeJoysoundText(currGlyph.charCode, currGlyph.font);
    const prevUnicodeChar =
      prevGlyph !== null
        ? decodeJoysoundText(prevGlyph.charCode, currGlyph.font)
        : null;

    if (
      prevUnicodeChar !== null &&
      isKanaUnicodeChar(prevUnicodeChar) &&
      !(isKanaUnicodeChar(unicodeChar) && prevUnicodeChar === "っ") &&
      !SUTEGANA.includes(unicodeChar) &&
      !(
        isKatakanaUnicodeChar(prevUnicodeChar) &&
        isKatakanaUnicodeChar(unicodeChar)
      ) &&
      unicodeChar !== "ー"
    ) {
      mainRomajiBlocks.push({
        phrase: kanaReadingToRomaji(currPhrase),
        xPos: currXPos,
        sourceWidth: currPhraseWidth,
      });

      currXPos += currPhraseWidth;
      currPhrase = "";
      currPhraseWidth = 0;
    }

    // XXX: Welcome hell
    if (!isKanaUnicodeChar(unicodeChar) || unicodeChar === "・") {
      currXPos += currGlyph.width;
    } else {
      if (
        tokenizedLyrics[tokenizedLyricsIndex].pronunciation &&
        !Kuroshiro.Util.hasKanji(
          tokenizedLyrics[tokenizedLyricsIndex].surface_form,
        ) &&
        tokenizedLyrics[tokenizedLyricsIndex].pronunciation[
          tokenizedLyricsCharIndex
        ] !== undefined &&
        tokenizedLyrics[tokenizedLyricsIndex].pronunciation[
          tokenizedLyricsCharIndex
        ] !== "ー" &&
        !(
          tokenizedLyricsIndex === 0 &&
          tokenizedLyrics[tokenizedLyricsIndex].surface_form === "は"
        )
      ) {
        currPhrase +=
          tokenizedLyrics[tokenizedLyricsIndex].pronunciation[
            tokenizedLyricsCharIndex
          ];
      } else if (
        tokenizedLyrics[tokenizedLyricsIndex].pronunciation &&
        tokenizedLyrics[tokenizedLyricsIndex].surface_form.length > 1 &&
        tokenizedLyricsCharIndex ===
          tokenizedLyrics[tokenizedLyricsIndex].surface_form.length - 1 &&
        tokenizedLyrics[tokenizedLyricsIndex].surface_form.slice(-1) === "は"
      ) {
        currPhrase +=
          tokenizedLyrics[tokenizedLyricsIndex].pronunciation.slice(-1);
      } else {
        currPhrase += unicodeChar;
      }

      currPhraseWidth += currGlyph.width;
    }

    prevGlyph = currGlyph;

    tokenizedLyricsCharIndex += 1;

    if (
      tokenizedLyrics[tokenizedLyricsIndex].surface_form.length ===
      tokenizedLyricsCharIndex
    ) {
      tokenizedLyricsIndex += 1;
      tokenizedLyricsCharIndex = 0;
    }
  }

  if (currPhrase) {
    mainRomajiBlocks.push({
      phrase: kanaReadingToRomaji(currPhrase),
      xPos: currXPos,
      sourceWidth: currPhraseWidth,
    });
  }

  return mainRomajiBlocks;
}

function getFuriganaRomajiBlocks(
  furigana: JoysoundLyricsFurigana[],
): JoysoundLyricsRomaji[] {
  const furiganaRomajiBlocks = [];

  for (const furiganaBlock of furigana) {
    const furiganaPhrase = furiganaBlock.chars
      .map((charCode) => decodeJoysoundText(charCode))
      .join("");

    const romajiPhrase = kanaReadingToRomaji(furiganaPhrase);

    furiganaRomajiBlocks.push({
      phrase: romajiPhrase,
      xPos: furiganaBlock.xPos,
      sourceWidth:
        furiganaPhrase.length * (RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2),
    });
  }

  return furiganaRomajiBlocks;
}

function getNonKanaRomajiBlocks(
  chars: JoysoundLyricsChar[],
  tokenizedLyrics: AnalyzerResult[],
): JoysoundLyricsRomaji[] {
  const fillerRomajiBlocks = [];

  let hiraganaPhrase = "";

  let currXPos = 0;
  let currPhrase = "";
  let currPhraseWidth = 0;

  let tokenizedLyricsIndex = 0;
  let tokenizedLyricsCharIndex = 0;

  for (const currGlyph of chars) {
    const unicodeChar = decodeJoysoundText(currGlyph.charCode, currGlyph.font);

    if (
      isKanjiUnicodeChar(unicodeChar) &&
      currGlyph.font === 0 &&
      (currPhrase.length > 0 || currGlyph.furiganaIndex < 0) &&
      !Kuroshiro.Util.hasKana(
        tokenizedLyrics[tokenizedLyricsIndex].surface_form,
      )
    ) {
      // XXX: This is a mega hack
      currGlyph.furiganaIndex = 6969;
      currPhrase += unicodeChar;
      currPhraseWidth += currGlyph.width;

      if (tokenizedLyricsCharIndex === 0) {
        hiraganaPhrase += tokenizedLyrics[tokenizedLyricsIndex].pronunciation;
      }
    } else {
      if (currPhrase.length > 0) {
        fillerRomajiBlocks.push({
          phrase: kanjiPhraseToRomaji(currPhrase, hiraganaPhrase),
          xPos: currXPos,
          sourceWidth: currPhraseWidth,
        });

        currXPos += currPhraseWidth;
        currPhrase = "";
        currPhraseWidth = 0;
        hiraganaPhrase = "";
      }
      currXPos += currGlyph.width;
    }

    tokenizedLyricsCharIndex += 1;

    if (
      tokenizedLyrics[tokenizedLyricsIndex].surface_form.length ===
      tokenizedLyricsCharIndex
    ) {
      tokenizedLyricsIndex += 1;
      tokenizedLyricsCharIndex = 0;
    }
  }

  if (currPhrase.length > 0) {
    fillerRomajiBlocks.push({
      phrase: kanjiPhraseToRomaji(currPhrase, hiraganaPhrase),
      xPos: currXPos,
      sourceWidth: currPhraseWidth,
    });
  }

  return fillerRomajiBlocks;
}

function getFillerRomajiBlocks(
  chars: JoysoundLyricsChar[],
  okuriganaLyrics: string,
): JoysoundLyricsRomaji[] {
  const fillerRomajiBlocks = [];

  let currXPos = 0;

  let hiraganaPhrase = "";
  let kanjiPhrase = "";
  let kanjiPhraseWidth = 0;

  let charIndex = 0;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const unicodeChar = decodeJoysoundText(char.charCode, char.font);

    if (
      !isKanjiUnicodeChar(unicodeChar) ||
      char.font !== 0 ||
      char.furiganaIndex >= 0
    ) {
      if (hiraganaPhrase.length > 0) {
        fillerRomajiBlocks.push({
          phrase: Kuroshiro.Util.kanaToRomaji(hiraganaPhrase, "hepburn"),
          xPos: currXPos,
          sourceWidth: kanjiPhraseWidth,
        });
      }

      currXPos += kanjiPhraseWidth + char.width;

      hiraganaPhrase = "";
      kanjiPhrase = "";
      kanjiPhraseWidth = 0;

      charIndex += 1;

      if (
        charIndex < okuriganaLyrics.length &&
        okuriganaLyrics[charIndex] === "¬"
      ) {
        charIndex += 1;

        while (
          charIndex < okuriganaLyrics.length &&
          okuriganaLyrics[charIndex] !== "¬"
        ) {
          charIndex += 1;
        }

        charIndex += 1;
      }

      continue;
    }

    kanjiPhrase += unicodeChar;
    kanjiPhraseWidth += char.width;

    charIndex += 1;

    while (
      charIndex < okuriganaLyrics.length &&
      okuriganaLyrics[charIndex] !== "¬"
    ) {
      kanjiPhrase += okuriganaLyrics[charIndex];

      charIndex += 1;
      i += 1;

      kanjiPhraseWidth += chars[i].width;
      chars[i].furiganaIndex = -1;
    }

    charIndex += 1;

    while (
      charIndex < okuriganaLyrics.length &&
      okuriganaLyrics[charIndex] !== "¬"
    ) {
      hiraganaPhrase += okuriganaLyrics[charIndex];
      charIndex += 1;
    }

    charIndex += 1;
  }

  if (hiraganaPhrase.length > 0) {
    fillerRomajiBlocks.push({
      phrase: Kuroshiro.Util.kanaToRomaji(hiraganaPhrase, "hepburn"),
      xPos: currXPos,
      sourceWidth: kanjiPhraseWidth,
    });
  }

  return fillerRomajiBlocks;
}

function mapCharsToFurigana(
  chars: JoysoundLyricsChar[],
  furiganaList: JoysoundLyricsFurigana[],
): void {
  let currXPos = 0;

  for (const char of chars) {
    // XXX: To map a character to furigana we assume the furigana must
    //      cover at least 8 pixels
    let bestIntersection = 8;
    const unicodeChar = decodeJoysoundText(char.charCode, char.font);

    for (let i = 0; i < furiganaList.length; i++) {
      const furigana = furiganaList[i];
      const intersection = intervalIntersection(
        currXPos,
        currXPos + char.width,
        furigana.xPos,
        furigana.xPos +
          furigana.chars.length * (RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2),
      );

      if (intersection > bestIntersection) {
        char.furiganaIndex = i;
        bestIntersection = intersection;
      }
    }

    currXPos += char.width;
  }
}

function deleteOverwrittenFuriganaRomaji(
  chars: JoysoundLyricsChar[],
  furiganaRomaji: JoysoundLyricsRomaji[],
): void {
  for (let i = furiganaRomaji.length - 1; i >= 0; i--) {
    let isFuriganaOverwritten = true;

    for (const char of chars) {
      if (char.furiganaIndex === i) {
        isFuriganaOverwritten = false;
        break;
      }
    }

    if (isFuriganaOverwritten) {
      furiganaRomaji.splice(i, 1);
    }
  }
}

async function parseLyricsBlock(
  view: DataView,
  offset: number,
  palette: JoysoundPaletteColor[],
  kuroshiro: KuroshiroSingleton,
) {
  let currOffset = offset;

  const blockSize = view.getUint16(currOffset, true);

  const flags = view.getUint16(currOffset + 2, true);
  const xPos = view.getUint16(currOffset + 4, true);
  const yPos = view.getUint16(currOffset + 6, true);
  const preFill = palette[view.getUint8(currOffset + 8)];
  const postFill = palette[view.getUint8(currOffset + 9)];
  const preBorder = palette[view.getUint8(currOffset + 10)];
  const postBorder = palette[view.getUint8(currOffset + 11)];

  const chars = [];
  const charCount = view.getUint16(currOffset + 12, true);

  currOffset += 14;

  for (let i = 0; i < charCount; i++) {
    const charFont = view.getUint8(currOffset);
    const charCode = view.getUint16(currOffset + 1, true);
    const charWidth = view.getUint16(currOffset + 3, true);

    chars.push({
      font: charFont,
      width: charWidth,
      charCode,
      furiganaIndex: -1,
    });

    currOffset += 5;
  }

  const furigana = [];
  const furiganaCount = view.getUint16(currOffset, true);

  currOffset += 2;

  for (let i = 0; i < furiganaCount; i++) {
    const furiganaChars = [];

    const furiganaLength = view.getUint16(currOffset, true);
    const furiganaXPos = view.getUint16(currOffset + 2, true);

    for (let j = 0; j < furiganaLength; j++) {
      furiganaChars.push(view.getUint16(currOffset + 4 + j * 2, true));
    }

    furigana.push({
      length: furiganaLength,
      xPos: furiganaXPos,
      chars: furiganaChars,
    });

    currOffset += 4 + furiganaLength * 2;
  }

  mapCharsToFurigana(chars, furigana);

  await kuroshiro.analyzerInitPromise;

  const rawLyrics = getRawLyrics(chars);
  const tokenizedLyrics = await kuroshiro.analyzer.parse(rawLyrics);
  const okuriganaLyrics = await kuroshiro.kuroshiro.convert(rawLyrics, {
    mode: "okurigana",
    to: "hiragana",
    delimiter_start: "¬",
    delimiter_end: "¬",
  });

  const mainRomaji = getMainRomajiBlocks(chars, tokenizedLyrics);
  const furiganaRomaji = getFuriganaRomajiBlocks(furigana);
  // XXX: For kanji without furigana and no kana (i.e. 空), we trust
  //      dictionary.json and fallback to kuroshiro
  const nonKanaRomaji = getNonKanaRomajiBlocks(chars, tokenizedLyrics);
  // XXX: For kanji without furigana and kana (i.e. 下げる), we trust
  //      kuroshiro's okurigana format
  const fillerRomaji = getFillerRomajiBlocks(chars, okuriganaLyrics);

  deleteOverwrittenFuriganaRomaji(chars, furiganaRomaji);

  const romaji = mainRomaji
    .concat(furiganaRomaji)
    .concat(nonKanaRomaji)
    .concat(fillerRomaji);

  return {
    blockSize,
    flags,
    xPos,
    yPos,
    preFill,
    postFill,
    preBorder,
    postBorder,
    chars,
    furigana,
    romaji,
    scrollEvents: [],
    fadeinTime: -1,
    fadeoutTime: -1,
  };
}

function readSJISString(view: DataView, offset: number, size: number): string {
  let unicodeString = "";
  let currOffset = offset;

  while (currOffset < offset + size) {
    if (view.getUint8(currOffset) === 0) {
      break;
    }

    let charCode;
    const firstByte = view.getUint8(currOffset);

    if (firstByte <= 0x7f || (firstByte > 0xa0 && firstByte <= 0xdf)) {
      charCode = view.getUint8(currOffset);

      unicodeString += decodeJoysoundText(charCode);
      currOffset += 1;

      continue;
    }

    charCode = view.getUint16(currOffset);
    unicodeString += decodeJoysoundText(charCode);

    currOffset += 2;
  }

  return unicodeString;
}

function parseJoy02Metadata(
  data: ArrayBuffer,
  offset: number,
  size: number,
): JoysoundMetadata {
  const metadataView = new DataView(data, offset, size);

  const currOffset = 0;

  const musicType = metadataView.getUint16(currOffset, true);
  const musicNameOffset = metadataView.getUint16(currOffset + 2, true);
  const artistNameOffset = metadataView.getUint16(currOffset + 4, true);
  const lyricistNameOffset = metadataView.getUint16(currOffset + 6, true);
  const composerNameOffset = metadataView.getUint16(currOffset + 8, true);
  const musicNameReadingOffset = metadataView.getUint16(currOffset + 10, true);
  const artistNameReadingOffset = metadataView.getUint16(currOffset + 12, true);
  const jasracCodeOffset = metadataView.getUint16(currOffset + 14, true);
  const musicDuration = metadataView.getUint16(currOffset + 18, true);

  const musicName = readSJISString(
    metadataView,
    musicNameOffset,
    artistNameOffset - musicNameOffset,
  );
  const artistName = readSJISString(
    metadataView,
    artistNameOffset,
    lyricistNameOffset - artistNameOffset,
  );
  const lyricistName = readSJISString(
    metadataView,
    lyricistNameOffset,
    composerNameOffset - lyricistNameOffset,
  );
  const composerName = readSJISString(
    metadataView,
    composerNameOffset,
    musicNameReadingOffset - composerNameOffset,
  );
  const musicNameReading = readSJISString(
    metadataView,
    musicNameReadingOffset,
    artistNameReadingOffset - musicNameReadingOffset,
  );
  const artistNameReading = readSJISString(
    metadataView,
    artistNameReadingOffset,
    jasracCodeOffset - artistNameReadingOffset,
  );

  return {
    musicName,
    artistName,
    lyricistName,
    composerName,
    musicNameReading,
    artistNameReading,
    fadeoutTime: 0,
  };
}

function intervalIntersection(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number {
  if (bStart > aEnd || aStart > bEnd) {
    return -1;
  }

  const intersectionStart = Math.max(aStart, bStart);
  const intersectionEnd = Math.min(aEnd, bEnd);

  return intersectionEnd - intersectionStart;
}

async function parseJoy02LyricsData(
  data: ArrayBuffer,
  offset: number,
  size: number,
  kuroshiro: KuroshiroSingleton,
): Promise<JoysoundLyricsBlock[]> {
  const lyricsView = new DataView(data, offset, size);
  const lyricsBlocks = [];

  const palette = [];

  let currOffset = 0;

  for (let i = 0; i < 15; i++) {
    const rgbData = lyricsView.getUint16(currOffset, true);
    const color = {
      id: i,
      rgb: [
        Math.floor((((rgbData >> 10) & 31) / 31) * 255),
        Math.floor((((rgbData >> 5) & 31) / 31) * 255),
        Math.floor((((rgbData >> 0) & 31) / 31) * 255),
      ],
    };

    palette.push(color);

    currOffset += 2;
  }

  while (currOffset < size) {
    const block = await parseLyricsBlock(
      lyricsView,
      currOffset,
      palette,
      kuroshiro,
    );
    lyricsBlocks.push(block);

    currOffset += block.blockSize;
  }

  return lyricsBlocks;
}

function parseJoy02TimingData(data: ArrayBuffer, offset: number, size: number) {
  const timingView = new DataView(data, offset, size);
  const events = [];

  let currOffset = 0;

  while (currOffset < size) {
    const currTime = timingView.getUint32(currOffset, true);

    const payloadSize = timingView.getUint8(currOffset + 4);
    const payloadBytes = [];

    for (let i = 0; i < payloadSize; i++) {
      payloadBytes.push(timingView.getUint8(currOffset + 5 + i));
    }

    currOffset += 5 + payloadSize;

    events.push({
      currTime,
      payload: payloadBytes,
    });
  }

  return events;
}

function processTimeline(
  timeline: JoysoundTimelineEvent[],
  metadata: JoysoundMetadata,
  lyricsData: JoysoundLyricsBlock[],
) {
  const activeLyricsBlocks = [];

  let currLyricsBlockIndex = -1;
  let scrollLyricsBlockIndex = -1;

  for (const currEvent of timeline) {
    const eventCode = currEvent.payload[0];

    if ([0, 1, 12, 13].includes(eventCode)) {
      if (eventCode % 2 === 0) {
        scrollLyricsBlockIndex += 1;

        while (lyricsData[scrollLyricsBlockIndex].flags === 0xff) {
          scrollLyricsBlockIndex += 1;
        }
      }

      const scrollSpeed = currEvent.payload[1] * (eventCode <= 1 ? 10 : 1);
      const scrollLyricsBlock = lyricsData[scrollLyricsBlockIndex];

      scrollLyricsBlock.scrollEvents.push({
        time: currEvent.currTime,
        speed: scrollSpeed,
      });
    } else if (currEvent.payload[0] === 4) {
      metadata.fadeoutTime = currEvent.currTime;
    } else if (currEvent.payload[0] === 5) {
      for (let i = 0; i < currEvent.payload[1]; i++) {
        const fadeoutIndex = activeLyricsBlocks.shift();
        invariant(fadeoutIndex !== undefined);

        lyricsData[fadeoutIndex].fadeoutTime = currEvent.currTime;
      }
    } else if (currEvent.payload[0] === 6) {
      for (let i = 0; i < currEvent.payload[1]; i++) {
        currLyricsBlockIndex += 1;

        lyricsData[currLyricsBlockIndex].fadeinTime = currEvent.currTime;
        activeLyricsBlocks.push(currLyricsBlockIndex);
      }
    }
  }
}

async function parseJoysoundData(
  data: ArrayBuffer,
  kuroshiro: KuroshiroSingleton,
): Promise<JoysoundTelopData> {
  const lyricsBlocks = [];

  const view = new DataView(data, 6, 3 * 4);

  const metadataOffset = view.getUint32(0 * 4, true);
  const lyricsOffset = view.getUint32(1 * 4, true);
  const timingOffset = view.getUint32(2 * 4, true);

  const metadata = parseJoy02Metadata(
    data,
    metadataOffset,
    lyricsOffset - metadataOffset,
  );
  const lyricsData = await parseJoy02LyricsData(
    data,
    lyricsOffset,
    timingOffset - lyricsOffset,
    kuroshiro,
  );
  const timeline = parseJoy02TimingData(
    data,
    timingOffset,
    data.byteLength - timingOffset,
  );

  processTimeline(timeline, metadata, lyricsData);

  return {
    metadata,
    lyrics: lyricsData,
    timeline,
  };
}

export function getSongDuration(data: ArrayBuffer): number {
  const offsetView = new DataView(data, 6, 4);
  const metadataOffset = offsetView.getUint32(0, true);
  const metadataView = new DataView(data, metadataOffset, 20);

  return metadataView.getUint16(18, true);
}

export default parseJoysoundData;
