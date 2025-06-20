import { RUBY_FONT_SIZE, RUBY_FONT_STROKE } from "../../common/constants";
import {
  JoysoundLyricsChar,
  LyricsBlock,
  LyricsLine,
} from "../../common/joysoundParser";
import * as settings from "./LyricsRendererSettings";

export function getFontFace(fontCode: number): string {
  return settings.FONT_FACE;
}

export function getLyricsBlockWidth(lyricsBlock: LyricsBlock): number {
  return getLyricsBlockRawWidth(lyricsBlock) + settings.TEXT_PADDING * 2;
}

export function getLyricsLineWidth(
  lyricsBlock: LyricsBlock,
  lineNum: number,
): number {
  return (
    getLyricsLineRawWidth(lyricsBlock, lineNum) + settings.TEXT_PADDING * 2
  );
}

export function getLyricsBlockLineInnerYPos(lyricsBlock: LyricsBlock): number {
  if (
    lyricsBlock.lyricsLines.every(
      (line) => line.furigana.length === 0 && line.romaji.length === 0,
    )
  ) {
    return 0;
  }

  return getFuriganaSize();
}

export function getLyricsBlockLineHeight(lyricsBlock: LyricsBlock): number {
  if (
    lyricsBlock.lyricsLines.every(
      (line) => line.furigana.length === 0 && line.romaji.length === 0,
    )
  ) {
    return (
      lyricsBlock.fontSize +
      lyricsBlock.fontStroke * 2 +
      settings.TEXT_PADDING * 2
    );
  }

  return (
    lyricsBlock.fontSize +
    lyricsBlock.fontStroke * 2 +
    getFuriganaSize() +
    settings.TEXT_PADDING * 2
  );
}

export function getLyricsBlockHeight(lyricsBlock: LyricsBlock): number {
  return getLyricsBlockLineHeight(lyricsBlock) * lyricsBlock.lyricsLines.length;
}

export function getFuriganaSize(): number {
  return RUBY_FONT_SIZE + RUBY_FONT_STROKE * 2;
}

export function getLyricsBlockRawWidth(lyricsBlock: LyricsBlock): number {
  return Math.max(
    ...lyricsBlock.lyricsLines.map((_, lineNum) =>
      getLyricsLineRawWidth(lyricsBlock, lineNum),
    ),
  );
}

export function getLyricsLineRawWidth(
  lyricsBlock: LyricsBlock,
  lineNum: number,
): number {
  const lyricsLine = lyricsBlock.lyricsLines[lineNum];

  const mainWidth = getLyricsLineCharsWidth(lyricsLine);
  const furiganaWidth = getLyricsLineFuriganaWidth(lyricsLine);

  return Math.max(mainWidth, furiganaWidth) + lyricsBlock.fontStroke * 2;
}

function getLyricsLineCharsWidth(lyricsLine: LyricsLine): number {
  return lyricsLine.chars
    .map((char) => char.width)
    .reduce((acc, curr) => acc + curr);
}

function getLyricsLineFuriganaWidth(lyricsLine: LyricsLine): number {
  if (lyricsLine.furigana.length === 0) {
    return 0;
  }

  const rightmostFuriganaBlock =
    lyricsLine.furigana[lyricsLine.furigana.length - 1];

  return (
    rightmostFuriganaBlock.xPos +
    getFuriganaSize() * rightmostFuriganaBlock.chars.length
  );
}

export function calcGlyphCharWidth(
  textCtx: CanvasRenderingContext2D,
  lyricsLine: LyricsLine,
  glyphChar: JoysoundLyricsChar,
): number {
  const mainCharWidth = Math.round(textCtx.measureText(glyphChar.char).width);

  if (glyphChar.furiganaIndex < 0) {
    return mainCharWidth;
  }

  const furigana = lyricsLine.furigana[glyphChar.furiganaIndex];
  const furiganaTotalChars = furigana.chars
    .map((char) => char.length)
    .reduce((curr, acc) => acc + curr, 0);

  const furiganaWidth = furiganaTotalChars * RUBY_FONT_SIZE;

  return Math.max(mainCharWidth, furiganaWidth);
}

export function getEmptySpaceWidth(textCtx: CanvasRenderingContext2D): number {
  return textCtx.measureText(" ").width;
}
