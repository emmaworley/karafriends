import { loadDefaultJapaneseParser } from "budoux";
import {
  JoysoundLyricsChar,
  JoysoundLyricsFurigana,
  JoysoundScrollEventRelative,
  LyricsBlock,
  LyricsLine,
} from "../../common/joysoundParser";
import { isJapaneseUnicodeChar } from "../../common/stringUtil";
import * as settings from "./LyricsRendererSettings";
import { getEmptySpaceWidth, getLyricsLineWidth } from "./LyricsRendererUtil";

interface ParagraphFormatDpItem {
  score: number;
  wordIndicies: number[][];
}

const budouxJapaneseParser = loadDefaultJapaneseParser();

function calcWordWidth(word: JoysoundLyricsChar[]) {
  return word.map((char) => char.width).reduce((acc, curr) => acc + curr, 0);
}

export function paragraphFormatLyricsData(
  lyricsData: LyricsBlock[],
  textCtx: CanvasRenderingContext2D,
  captionCode: string,
): void {
  const emptySpaceWidth = getEmptySpaceWidth(textCtx);

  for (const lyricsBlock of lyricsData) {
    let idx = 0;

    while (idx < lyricsBlock.lyricsLines.length) {
      const lyricsLine = lyricsBlock.lyricsLines[idx];

      if (getLyricsLineWidth(lyricsBlock, idx) < settings.SCREEN_WIDTH) {
        idx += 1;
        continue;
      }

      const newLyricsLines = paragraphFormatLyricsLine(
        lyricsLine,
        captionCode,
        emptySpaceWidth,
        lyricsBlock.fontStroke,
      );

      lyricsBlock.lyricsLines.splice(idx, 1);

      for (const newLyricsLine of newLyricsLines) {
        lyricsBlock.lyricsLines.splice(idx, 0, newLyricsLine);
        idx += 1;
      }
    }
  }
}

function paragraphFormatLyricsLine(
  lyricsLine: LyricsLine,
  captionCode: string,
  emptySpaceWidth: number,
  fontStroke: number,
): LyricsLine[] {
  const result: LyricsLine[] = [];
  const initialWordsList = preprocessLyricsCharsForLanguage(
    lyricsLine.chars,
    captionCode,
  );

  let wordsList: JoysoundLyricsChar[][] = [];

  for (const words of initialWordsList) {
    wordsList = wordsList.concat(convertCharsToWords(words));
  }

  const wordsByLine: JoysoundLyricsChar[][][] = executeDp(
    wordsList,
    emptySpaceWidth,
    fontStroke,
  ).wordIndicies.map((wordIndicies) =>
    wordIndicies.map((wordIdx) => wordsList[wordIdx]),
  );

  let currIdx = 0;

  for (const words of wordsByLine) {
    let wordIdx = 0;
    let offset = 0;

    // Trim the start of the line
    while (lyricsLine.chars[currIdx].char === " ") {
      currIdx += 1;
    }

    while (wordIdx < words.length) {
      while (lyricsLine.chars[currIdx + offset].char === " ") {
        offset += 1;
      }

      offset += words[wordIdx].length;
      wordIdx += 1;
    }

    const nextLyricsLine: LyricsLine = createNewLyricsLine(
      lyricsLine,
      currIdx,
      currIdx + offset,
    );

    result.push(nextLyricsLine);
    currIdx += offset;
  }

  return result;
}

function createNewLyricsLine(
  oldLyricsLine: LyricsLine,
  lastIdx: number,
  idx: number,
): LyricsLine {
  const newScrollEvents = getScrollEventsBetween(
    oldLyricsLine.scrollEvents as JoysoundScrollEventRelative[],
    lastIdx,
    idx,
  );

  const newGlyphChars = oldLyricsLine.chars.slice(lastIdx, idx);
  const newFurigana: JoysoundLyricsFurigana[] = [];

  for (const glyphChar of newGlyphChars) {
    if (glyphChar.furiganaIndex >= 0) {
      newFurigana.push(oldLyricsLine.furigana[glyphChar.furiganaIndex]);
      glyphChar.furiganaIndex = newFurigana.length - 1;
    }
  }

  return {
    ...oldLyricsLine,
    chars: newGlyphChars,
    furigana: newFurigana,
    scrollEvents: newScrollEvents,
  };
}

function preprocessLyricsCharsForLanguage(
  chars: JoysoundLyricsChar[],
  captionCode: string,
): JoysoundLyricsChar[][] {
  let budouxParser;

  // Some songs have Japanese subtitles even though they're listed as another
  // language (e.g. Korean).
  if (
    captionCode.includes("ja") ||
    chars.filter((char) => isJapaneseUnicodeChar(char.char)).length > 0
  ) {
    budouxParser = budouxJapaneseParser;
  } else {
    return [chars];
  }

  const wordsList: JoysoundLyricsChar[][] = [];

  const rawText = chars.map((char) => char.char).join("");
  const bodouxParsedText = budouxParser.parse(rawText);

  let i = 0;

  for (const phrase of bodouxParsedText) {
    const realWord = [];

    for (const _ of phrase) {
      realWord.push(chars[i]);
      i += 1;
    }

    wordsList.push(realWord);
  }

  return wordsList;
}

function convertCharsToWords(
  chars: JoysoundLyricsChar[],
): JoysoundLyricsChar[][] {
  const wordsList: JoysoundLyricsChar[][] = [];
  let currWord: JoysoundLyricsChar[] = [];

  for (const glyphChar of chars) {
    if (glyphChar.char === " ") {
      if (currWord.length > 0) {
        wordsList.push(currWord);
        currWord = [];
      }

      continue;
    }

    currWord.push(glyphChar);
  }

  if (currWord.length > 0) {
    wordsList.push(currWord);
  }

  return wordsList;
}

function executeDp(
  wordsList: JoysoundLyricsChar[][],
  emptySpaceWidth: number,
  fontStroke: number,
): ParagraphFormatDpItem {
  const maxWidth = settings.SCREEN_WIDTH - settings.TEXT_PADDING * 2;

  const dpTable: ParagraphFormatDpItem[] = Array.from(
    Array(wordsList.length + 1),
  ).map((_) => {
    return {
      wordIndicies: [],
      score: -1,
    };
  });

  dpTable[wordsList.length].score = 0;

  for (let i = wordsList.length - 1; i >= 0; i--) {
    let totalWidth = fontStroke * 2;
    let offset = 0;

    let bestWordIndicies: number[][] = [];
    let bestScore = -1;

    while (i + offset < wordsList.length) {
      totalWidth += calcWordWidth(wordsList[i + offset]);

      if (totalWidth >= maxWidth) {
        break;
      }

      const nextDp = dpTable[i + offset + 1];
      const currScore = (maxWidth - totalWidth) ** 2 + nextDp.score;

      if (bestScore >= 0 && bestScore <= currScore) {
        offset += 1;
        totalWidth += emptySpaceWidth;
        continue;
      }

      bestScore = currScore;

      const currWordIndicies = Array.from(Array(offset + 1).keys()).map(
        (wordIdx) => i + wordIdx,
      );

      bestWordIndicies = [currWordIndicies].concat(nextDp.wordIndicies);

      offset += 1;
      totalWidth += emptySpaceWidth;
    }

    dpTable[i] = {
      wordIndicies: bestWordIndicies,
      score: bestScore,
    };
  }

  return dpTable[0];
}

function getScrollEventsBetween(
  scrollEvents: JoysoundScrollEventRelative[],
  leftIdx: number,
  rightIdx: number,
): JoysoundScrollEventRelative[] {
  const newScrollEvents = [];

  for (const scrollEvent of scrollEvents) {
    if (
      scrollEvent.charStartIdx <= leftIdx &&
      scrollEvent.charEndIdx > leftIdx
    ) {
      const newScrollEvent: JoysoundScrollEventRelative = {
        ...scrollEvent,
        charStartIdx: 0,
        charEndIdx: Math.min(rightIdx, scrollEvent.charEndIdx) - leftIdx,
      };

      newScrollEvents.push(newScrollEvent);
      continue;
    }

    if (
      scrollEvent.charStartIdx < rightIdx &&
      scrollEvent.charEndIdx >= rightIdx
    ) {
      const newScrollEvent: JoysoundScrollEventRelative = {
        ...scrollEvent,
        charStartIdx: Math.max(scrollEvent.charStartIdx, leftIdx) - leftIdx,
        charEndIdx: rightIdx - leftIdx,
      };

      newScrollEvents.push(newScrollEvent);
      break;
    }

    if (
      scrollEvent.charStartIdx > leftIdx &&
      scrollEvent.charEndIdx < rightIdx
    ) {
      const newScrollEvent: JoysoundScrollEventRelative = {
        ...scrollEvent,
        charStartIdx: scrollEvent.charStartIdx - leftIdx,
        charEndIdx: scrollEvent.charEndIdx - leftIdx,
      };

      newScrollEvents.push(newScrollEvent);
    }
  }

  return newScrollEvents;
}
