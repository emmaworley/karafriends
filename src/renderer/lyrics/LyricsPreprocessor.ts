import invariant from "ts-invariant";
import { paragraphFormatLyricsData } from "./LyricsFormatter";

import * as settings from "./LyricsRendererSettings";
import {
  calcGlyphCharWidth,
  getFontFace,
  getFuriganaSize,
  getLyricsBlockHeight,
  getLyricsBlockRawWidth,
} from "./LyricsRendererUtil";

import { RUBY_FONT_SIZE, RUBY_FONT_STROKE } from "../../common/constants";

import { LyricsBlock } from "../../common/joysoundParser";

export default function preprocessLyricsData(
  lyricsData: LyricsBlock[],
  captionCode: string,
) {
  const textCtx = setupTextContext(lyricsData);

  refreshLyricsDataWidths(lyricsData, textCtx);
  paragraphFormatLyricsData(lyricsData, textCtx, captionCode);
  refreshLyricsDataXPos(lyricsData);
  refreshLyricsDataYPos(lyricsData);
  refreshLyricsDataFuriganaXPos(lyricsData);

  textCtx.canvas.remove();

  console.log(lyricsData);
}

function setupTextContext(lyricsData: LyricsBlock[]): CanvasRenderingContext2D {
  const textCtx = document.createElement("canvas").getContext("2d");
  invariant(textCtx);

  // TODO: Update fontSize and fontStroke to be part of lyrics metadata
  textCtx.font = `${lyricsData[0].fontSize}px ${getFontFace(0)}`;
  textCtx.lineWidth = lyricsData[0].fontStroke * 2;

  return textCtx;
}

function refreshLyricsDataWidths(
  lyricsData: LyricsBlock[],
  textCtx: CanvasRenderingContext2D,
): void {
  for (const lyricsBlock of lyricsData) {
    refreshLyricsBlockCharsWidth(lyricsBlock, textCtx);
  }
}

function refreshLyricsDataXPos(lyricsData: LyricsBlock[]): void {
  for (const lyricsBlock of lyricsData) {
    if (lyricsBlock.xPos >= 0) {
      continue;
    }

    lyricsBlock.xPos = Math.floor(
      (settings.SCREEN_WIDTH - getLyricsBlockRawWidth(lyricsBlock)) / 2,
    );
  }
}

function refreshVisibleLyricsBlocks(
  lyricsBlock: LyricsBlock,
  visibleLyricsBlocks: (LyricsBlock | null)[],
) {
  for (let i = visibleLyricsBlocks.length - 1; i >= 0; i--) {
    const visibleLyricsBlock = visibleLyricsBlocks[i];

    if (visibleLyricsBlock === null) {
      continue;
    }

    if (lyricsBlock.fadeinTime >= visibleLyricsBlock.fadeoutTime) {
      if (i === visibleLyricsBlocks.length - 1) {
        visibleLyricsBlocks.splice(i, 1);
      } else {
        visibleLyricsBlocks[i] = null;
      }
    }
  }
}

function processLyricsBlockMaxLines(
  lyricsBlock: LyricsBlock,
  visibleLyricsBlocks: (LyricsBlock | null)[],
  lyricsMaxLines: number[],
  activeLyricsBlocks: (LyricsBlock | null)[],
  lyricsBlocksMaxLineIndicies: number[],
) {
  let i;

  for (i = 0; i <= visibleLyricsBlocks.length; i++) {
    if (i < visibleLyricsBlocks.length && visibleLyricsBlocks[i] !== null) {
      continue;
    }

    if (i === visibleLyricsBlocks.length) {
      visibleLyricsBlocks.push(lyricsBlock);
    } else {
      visibleLyricsBlocks[i] = lyricsBlock;
    }

    if (i === lyricsMaxLines.length) {
      lyricsMaxLines.push(getLyricsBlockHeight(lyricsBlock));
    } else {
      lyricsMaxLines[i] = Math.max(
        lyricsMaxLines[i],
        getLyricsBlockHeight(lyricsBlock),
      );
    }

    break;
  }

  activeLyricsBlocks.push(lyricsBlock);
  lyricsBlocksMaxLineIndicies.push(i);
}

function refreshLyricsDataYPos(lyricsData: LyricsBlock[]): void {
  refreshTopLyricsBlocksYPos(lyricsData);
  refreshBottomLyricsBlocksYPos(lyricsData);
}

function commitTopActiveLyricsBlocks(
  activeLyricsBlocks: LyricsBlock[],
  lyricsMaxLines: number[],
  lyricsBlocksMaxLineIndicies: number[],
): void {
  const lyricsYPosList = getTopLyricsYPosList(lyricsMaxLines);

  for (let i = 0; i < activeLyricsBlocks.length; i++) {
    const lyricsBlock = activeLyricsBlocks[i];

    lyricsBlock.yPos = lyricsYPosList[lyricsBlocksMaxLineIndicies[i]];
  }
}

function commitBottomActiveLyricsBlocks(
  activeLyricsBlocks: LyricsBlock[],
  lyricsMaxLines: number[],
  lyricsBlocksMaxLineIndicies: number[],
): void {
  const lyricsYPosList = getBottomLyricsYPosList(lyricsMaxLines);

  for (let i = 0; i < activeLyricsBlocks.length; i++) {
    const prevLyricsBlock = activeLyricsBlocks[i];

    prevLyricsBlock.yPos =
      lyricsYPosList[lyricsBlocksMaxLineIndicies[i]] -
      getLyricsBlockHeight(prevLyricsBlock);
  }
}

function refreshTopLyricsBlocksYPos(lyricsData: LyricsBlock[]): void {
  let activeLyricsBlocks: LyricsBlock[] = [];
  const visibleLyricsBlocks: (LyricsBlock | null)[] = [];
  let lyricsMaxLines: number[] = [];
  let lyricsBlocksMaxLineIndicies: number[] = [];

  for (const lyricsBlock of lyricsData) {
    if (lyricsBlock.yPos !== -1) {
      continue;
    }

    const oldVisibleLyricsBlocksLength = visibleLyricsBlocks.length;
    refreshVisibleLyricsBlocks(lyricsBlock, visibleLyricsBlocks);

    if (oldVisibleLyricsBlocksLength > 0 && visibleLyricsBlocks.length === 0) {
      commitTopActiveLyricsBlocks(
        activeLyricsBlocks,
        lyricsMaxLines,
        lyricsBlocksMaxLineIndicies,
      );

      activeLyricsBlocks = [];
      lyricsMaxLines = [];
      lyricsBlocksMaxLineIndicies = [];
    }

    processLyricsBlockMaxLines(
      lyricsBlock,
      visibleLyricsBlocks,
      lyricsMaxLines,
      activeLyricsBlocks,
      lyricsBlocksMaxLineIndicies,
    );
  }

  commitTopActiveLyricsBlocks(
    activeLyricsBlocks,
    lyricsMaxLines,
    lyricsBlocksMaxLineIndicies,
  );
}

function refreshBottomLyricsBlocksYPos(lyricsData: LyricsBlock[]): void {
  let activeLyricsBlocks: LyricsBlock[] = [];
  const visibleLyricsBlocks: (LyricsBlock | null)[] = [];
  let lyricsMaxLines: number[] = [];
  let lyricsBlocksMaxLineIndicies: number[] = [];

  for (const lyricsBlock of lyricsData) {
    if (lyricsBlock.yPos !== -2) {
      continue;
    }

    const oldVisibleLyricsBlocksLength = visibleLyricsBlocks.length;
    refreshVisibleLyricsBlocks(lyricsBlock, visibleLyricsBlocks);

    if (oldVisibleLyricsBlocksLength > 0 && visibleLyricsBlocks.length === 0) {
      commitBottomActiveLyricsBlocks(
        activeLyricsBlocks,
        lyricsMaxLines,
        lyricsBlocksMaxLineIndicies,
      );

      activeLyricsBlocks = [];
      lyricsMaxLines = [];
      lyricsBlocksMaxLineIndicies = [];
    }

    processLyricsBlockMaxLines(
      lyricsBlock,
      visibleLyricsBlocks,
      lyricsMaxLines,
      activeLyricsBlocks,
      lyricsBlocksMaxLineIndicies,
    );
  }

  commitBottomActiveLyricsBlocks(
    activeLyricsBlocks,
    lyricsMaxLines,
    lyricsBlocksMaxLineIndicies,
  );
}

function refreshLyricsDataFuriganaXPos(lyricsData: LyricsBlock[]): void {
  const textCtx = document.createElement("canvas").getContext("2d");
  invariant(textCtx);

  for (const lyricsBlock of lyricsData) {
    refreshLyricsBlockFuriganaXPos(lyricsBlock, textCtx);
  }

  textCtx.canvas.remove();
}

// TODO: Fix this -- fontSize should not live on lyricsBlock tbh...
//       should live in metadata
function getTopLyricsYPosList(lyricsMaxLines: number[]): number[] {
  const lyricsYPosList: number[] = [0];
  let yPos = 0;

  for (const maxLine of lyricsMaxLines) {
    yPos += maxLine;
    lyricsYPosList.push(yPos);
  }

  return lyricsYPosList;
}

function getBottomLyricsYPosList(lyricsMaxLines: number[]): number[] {
  let yPos = settings.SCREEN_HEIGHT;

  const lyricsYPosList: number[] = [yPos];

  for (const maxLine of lyricsMaxLines) {
    yPos -= maxLine;
    lyricsYPosList.push(yPos);
  }

  return lyricsYPosList;
}

function refreshLyricsBlockCharsWidth(
  lyricsBlock: LyricsBlock,
  textCtx: CanvasRenderingContext2D | null,
): void {
  invariant(textCtx);

  for (const lyricsLine of lyricsBlock.lyricsLines) {
    for (const glyphChar of lyricsLine.chars) {
      if (glyphChar.width >= 0) {
        continue;
      }

      textCtx.font = `${lyricsBlock.fontSize}px ${getFontFace(glyphChar.font)}`;
      textCtx.lineWidth = lyricsBlock.fontStroke * 2;

      glyphChar.width = calcGlyphCharWidth(textCtx, lyricsLine, glyphChar);
    }
  }
}

function refreshLyricsBlockFuriganaXPos(
  lyricsBlock: LyricsBlock,
  textCtx: CanvasRenderingContext2D | null,
): void {
  invariant(textCtx);

  for (const lyricsLine of lyricsBlock.lyricsLines) {
    let xOff = 0;

    for (const glyphChar of lyricsLine.chars) {
      if (glyphChar.furiganaIndex < 0) {
        xOff += glyphChar.width;
        continue;
      }

      textCtx.font = `${RUBY_FONT_SIZE}px ${getFontFace(glyphChar.font)}`;
      textCtx.lineWidth = RUBY_FONT_STROKE * 2;

      const furiganaWidth =
        lyricsLine.furigana[glyphChar.furiganaIndex].chars.length *
        RUBY_FONT_SIZE;

      lyricsLine.furigana[glyphChar.furiganaIndex].xPos =
        xOff + (glyphChar.width - furiganaWidth) / 2;

      xOff += glyphChar.width;
    }
  }
}
