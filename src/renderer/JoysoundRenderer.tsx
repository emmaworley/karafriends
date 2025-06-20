import React, { useEffect, useRef } from "react";
import invariant from "ts-invariant";

import "./JoysoundRenderer.css";
import * as settings from "./lyrics/LyricsRendererSettings";

import {
  getLyricsBlockLineHeight,
  getLyricsBlockLineInnerYPos,
  getLyricsBlockWidth,
  getLyricsLineWidth,
} from "./lyrics/LyricsRendererUtil";

import {
  JoysoundMetadata,
  JoysoundScrollEventAbsolute,
  JoysoundScrollEventRelative,
  LyricsBlock,
  LyricsData,
  LyricsMetadata,
  LyricsScrollStyle,
} from "../common/joysoundParser";

import preprocessLyricsData from "./lyrics/LyricsPreprocessor";

import { RUBY_FONT_SIZE, RUBY_FONT_STROKE } from "../common/constants";

// XXX: These should be in their own file

const vsSource = `#version 300 es
  in vec2 a_position;
  in vec2 a_texCoord;
  in float a_scroll;
  in float a_scrollType;

  uniform vec2 u_resolution;

  out vec2 v_texCoord;
  out vec2 v_position;
  out float v_scroll;
  out float v_scrollType;

  void main() {
    vec2 clipSpace = (a_position / u_resolution) * 2.0 - 1.0;
    gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);

    v_texCoord = a_texCoord;
    v_position = a_position;
    v_scroll = a_scroll;
    v_scrollType = a_scrollType;
  }
`;

const fsSource = `#version 300 es
  precision highp float;

  uniform sampler2D u_image;

  in vec2 v_texCoord;
  in vec2 v_position;
  in float v_scroll;
  in float v_scrollType;

  out vec4 outColor;

  void main() {
    vec4 textureColor = texture(u_image, v_texCoord);

    if (
      (v_scrollType == 0.0 && v_position.x <= v_scroll) ||
      (v_scrollType == 1.0 && v_position.x > v_scroll)
    ) {
      outColor = vec4(0.0, 0.0, 0.0, 0.0);
    } else {
      outColor = vec4(textureColor.r, textureColor.g, textureColor.b, textureColor.a);
    }
  }
`;

let EXPAND_RATE = 1.0;
let EXPAND_RATE_X = 1.0;
let EXPAND_RATE_Y = 1.0;

const TIMING_OFFSET = -200;

interface LyricsLineTextures {
  preTexture: WebGLTexture;
  postTexture: WebGLTexture;
}

interface JoysoundTitleRow {
  text: string;
  width: number;
}

interface JoysoundDisplayBuffers {
  position: WebGLBuffer;
  texCoord: WebGLBuffer;
  scroll: WebGLBuffer;
  scrollType: WebGLBuffer;
}

function setTextContextFontSize(
  textCtx: CanvasRenderingContext2D,
  fontSize: number,
  scaleToExpandRate: boolean = false,
): void {
  const expandRate = scaleToExpandRate ? EXPAND_RATE : 1;
  textCtx.font = `${fontSize * expandRate}px ${settings.FONT_FACE}`;
}

function createShader(
  gl: WebGL2RenderingContext,
  type:
    | WebGLRenderingContextBase["VERTEX_SHADER"]
    | WebGLRenderingContextBase["FRAGMENT_SHADER"],
  source: string,
) {
  const shader = gl.createShader(type);
  invariant(shader);

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexShader: WebGLShader,
  fragmentShader: WebGLShader,
) {
  const program = gl.createProgram();
  invariant(program);

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  return program;
}

function quadToTriangles(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number[] {
  return [x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1];
}

function createTextureFromImage(
  gl: WebGL2RenderingContext,
  bitmap: HTMLCanvasElement,
): WebGLTexture {
  const texture = gl.createTexture();
  invariant(texture);

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

  return texture;
}

function setupTextCanvas(
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: LyricsBlock,
  lineNum: number,
  strokeColor: number[],
): void {
  textCtx.canvas.width =
    getLyricsLineWidth(lyricsBlock, lineNum) * EXPAND_RATE_X;
  textCtx.canvas.height = getLyricsBlockLineHeight(lyricsBlock) * EXPAND_RATE_Y;
  textCtx.clearRect(0, 0, textCtx.canvas.width, textCtx.canvas.height);

  textCtx.textBaseline = "top";
  textCtx.lineJoin = "round";
  textCtx.strokeStyle = `rgb(${strokeColor.join(", ")})`;

  // DEBUG Mode
  // textCtx.fillRect(0, 0, textCtx.canvas.width, textCtx.canvas.height);
}

function setupTitleCanvas(textCtx: CanvasRenderingContext2D): void {
  textCtx.canvas.width = settings.SCREEN_WIDTH * EXPAND_RATE_X;
  textCtx.canvas.height = settings.SCREEN_HEIGHT * EXPAND_RATE_Y;
  textCtx.clearRect(0, 0, textCtx.canvas.width, textCtx.canvas.height);

  textCtx.textBaseline = "top";
  textCtx.lineJoin = "round";
  textCtx.fillStyle = `rgb(255, 255, 255)`;
  textCtx.strokeStyle = `rgb(8, 8, 8)`;
}

function createTitleRows(
  textCtx: CanvasRenderingContext2D,
  fontStroke: number,
  title: string,
): JoysoundTitleRow[] {
  const titleRows = [];

  let currTitleText = "";
  let currTitleWidth = 0;

  for (const nextChar of title) {
    const nextTitleWidth = textCtx.measureText(currTitleText + nextChar).width;

    if (
      nextTitleWidth >=
      (settings.SCREEN_WIDTH - (settings.TEXT_PADDING + fontStroke + 16) * 2) *
        EXPAND_RATE_X
    ) {
      titleRows.push({ text: currTitleText, width: currTitleWidth });

      currTitleText = nextChar;
      currTitleWidth = textCtx.measureText(nextChar).width;
    } else {
      currTitleText += nextChar;
      currTitleWidth = nextTitleWidth;
    }
  }

  titleRows.push({ text: currTitleText, width: currTitleWidth });

  return titleRows;
}

function drawTitleRowsToCanvas(
  textCtx: CanvasRenderingContext2D,
  titleRows: JoysoundTitleRow[],
  fontSize: number,
  fontStroke: number,
  yPos: number,
) {
  for (const titleRow of titleRows) {
    const titleRowPaddedWidth =
      titleRow.width + (settings.TEXT_PADDING + fontStroke) * EXPAND_RATE_X * 2;

    const xPos = Math.max(
      0,
      (settings.SCREEN_WIDTH * EXPAND_RATE_X - titleRowPaddedWidth) /
        2 /
        EXPAND_RATE_X,
    );

    drawTextToCanvas(textCtx, fontSize, fontStroke, xPos, yPos, titleRow.text);

    yPos += fontSize + fontStroke * 2;
  }
}

function createTitleTexture(
  gl: WebGL2RenderingContext,
  rawMetadata: JoysoundMetadata | LyricsMetadata,
  isRomaji: boolean,
): WebGLTexture | null {
  if (rawMetadata.captionCode !== "") {
    return null;
  }

  const metadata = rawMetadata as JoysoundMetadata;

  const textCtx = document.createElement("canvas").getContext("2d");
  invariant(textCtx);

  setupTitleCanvas(textCtx);

  const titleFontSize =
    metadata.musicName.length < 48
      ? settings.TITLE_FONT_SIZE
      : settings.ARTIST_FONT_SIZE;
  const titleFontStroke =
    metadata.musicName.length < 48
      ? settings.TITLE_FONT_STROKE
      : settings.ARTIST_FONT_STROKE;

  setTextContextFontSize(textCtx, titleFontSize, true);

  const titleRows = createTitleRows(
    textCtx,
    titleFontStroke,
    metadata.musicName,
  );
  const titleHeight =
    (titleFontSize + settings.TITLE_FONT_STROKE * 2) *
    titleRows.length *
    EXPAND_RATE_Y;

  const artistFontSize =
    metadata.artistName.length < 64
      ? settings.ARTIST_FONT_SIZE
      : settings.METADATA_FONT_SIZE;
  const artistFontStroke =
    metadata.artistName.length < 64
      ? settings.ARTIST_FONT_STROKE
      : settings.METADATA_FONT_STROKE;

  setTextContextFontSize(textCtx, artistFontSize, true);

  const artistRows = createTitleRows(
    textCtx,
    artistFontStroke,
    "♪ " + metadata.artistName,
  );
  const artistHeight =
    (artistFontSize + settings.ARTIST_FONT_STROKE * 2) *
    artistRows.length *
    EXPAND_RATE_Y;

  setTextContextFontSize(textCtx, settings.METADATA_FONT_SIZE, true);

  const lyricistText =
    (isRomaji ? "Lyrics: " : "作詞 ") + metadata.lyricistName;
  const lyricistMeasure = textCtx.measureText(lyricistText);
  const lyricistHeight =
    lyricistMeasure.actualBoundingBoxAscent +
    lyricistMeasure.actualBoundingBoxDescent;

  const composerText =
    (isRomaji ? "Composer: " : "作曲 ") + metadata.composerName;
  const composerMeasure = textCtx.measureText(composerText);
  const composerHeight =
    composerMeasure.actualBoundingBoxAscent +
    composerMeasure.actualBoundingBoxDescent;

  const totalHeight =
    titleHeight +
    artistHeight +
    lyricistHeight +
    composerHeight +
    144 * EXPAND_RATE_Y;

  const titleYPos =
    (settings.SCREEN_HEIGHT * EXPAND_RATE_Y - totalHeight) / 2 / EXPAND_RATE_Y -
    settings.TEXT_PADDING;
  const artistYPos = titleYPos + titleHeight / EXPAND_RATE_Y + 64;
  const lyricistYPos = artistYPos + artistHeight / EXPAND_RATE_Y + 64;
  const composerYPos = lyricistYPos + lyricistHeight / EXPAND_RATE_Y + 16;

  drawTitleRowsToCanvas(
    textCtx,
    titleRows,
    titleFontSize,
    settings.TITLE_FONT_STROKE,
    titleYPos,
  );
  drawTitleRowsToCanvas(
    textCtx,
    artistRows,
    artistFontSize,
    settings.ARTIST_FONT_STROKE,
    artistYPos,
  );

  drawTextToCanvas(
    textCtx,
    settings.METADATA_FONT_SIZE,
    settings.METADATA_FONT_STROKE,
    48 - settings.TEXT_PADDING,
    lyricistYPos,
    lyricistText,
  );

  drawTextToCanvas(
    textCtx,
    settings.METADATA_FONT_SIZE,
    settings.METADATA_FONT_STROKE,
    48 - settings.TEXT_PADDING,
    composerYPos,
    composerText,
  );

  const result = createTextureFromImage(gl, textCtx.canvas);

  textCtx.canvas.remove();

  return result;
}

function createLyricsLineTexture(
  gl: WebGL2RenderingContext,
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: LyricsBlock,
  lineNum: number,
  strokeColor: number[],
  isRomaji: boolean,
  isPreFill: boolean,
): WebGLTexture {
  setupTextCanvas(textCtx, lyricsBlock, lineNum, strokeColor);

  drawMainTextToCanvas(textCtx, lyricsBlock, lineNum, isPreFill);

  if (isRomaji) {
    drawRomajiTextToCanvas(textCtx, lyricsBlock, lineNum, isPreFill);
  } else {
    drawFuriganaTextToCanvas(textCtx, lyricsBlock, lineNum, isPreFill);
  }

  return createTextureFromImage(gl, textCtx.canvas);
}

function getTextOffset(
  textCtx: CanvasRenderingContext2D,
  text: string,
  charWidth: number,
): number {
  const measure = textCtx.measureText(text);

  if (charWidth >= measure.width) {
    return (charWidth - measure.width) / 2;
  }

  if (
    measure.actualBoundingBoxLeft === 0 ||
    measure.actualBoundingBoxRight === 0
  ) {
    return (charWidth - measure.width) / 2;
  }

  const boundingBoxWidth =
    measure.actualBoundingBoxLeft + measure.actualBoundingBoxRight;
  const widthDiff = measure.width - charWidth;
  const halfDiff = widthDiff / 2;

  let leftOverflow = -1 * measure.actualBoundingBoxLeft;
  let rightOverflow = measure.width - measure.actualBoundingBoxRight;

  let isLeftOverflow = false;

  if (leftOverflow >= halfDiff) {
    leftOverflow -= halfDiff;
    isLeftOverflow = true;
  }

  let isRightOverflow = false;

  if (rightOverflow >= halfDiff) {
    rightOverflow -= halfDiff;
    isRightOverflow = true;
  }

  if (isLeftOverflow) {
    if (isRightOverflow) {
      return leftOverflow + measure.actualBoundingBoxLeft;
    } else if (leftOverflow >= halfDiff - rightOverflow) {
      return (
        leftOverflow -
        (halfDiff - rightOverflow) +
        measure.actualBoundingBoxLeft
      );
    }
  } else if (isRightOverflow && rightOverflow >= widthDiff - leftOverflow) {
    return measure.actualBoundingBoxLeft;
  }

  return (charWidth - boundingBoxWidth) / 2 + measure.actualBoundingBoxLeft;
}

function getRomajiTextOffset(
  textCtx: CanvasRenderingContext2D,
  text: string,
  sourceWidth: number,
): number {
  const measure = textCtx.measureText(text);

  return (sourceWidth - measure.width) / 2;
}

function drawTextToCanvas(
  textCtx: CanvasRenderingContext2D,
  fontSize: number,
  fontStroke: number,
  xPos: number,
  yPos: number,
  text: string,
): void {
  setTextContextFontSize(textCtx, fontSize, true);
  textCtx.lineWidth = fontStroke * 2 * EXPAND_RATE;

  textCtx.strokeText(
    text,
    (xPos + fontStroke + settings.TEXT_PADDING) * EXPAND_RATE_X,
    (yPos + fontStroke + settings.TEXT_PADDING) * EXPAND_RATE_Y,
  );

  textCtx.fillText(
    text,
    (xPos + fontStroke + settings.TEXT_PADDING) * EXPAND_RATE_X,
    (yPos + fontStroke + settings.TEXT_PADDING) * EXPAND_RATE_Y,
  );
}

function drawMainTextToCanvas(
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: LyricsBlock,
  lineNum: number,
  isPreFill: boolean,
): void {
  const lyricsLine = lyricsBlock.lyricsLines[lineNum];
  let currX = 0;

  for (const glyphChar of lyricsLine.chars) {
    const fillColor = isPreFill
      ? glyphChar.preFillColor
      : glyphChar.postFillColor;

    setTextContextFontSize(textCtx, lyricsBlock.fontSize);
    textCtx.fillStyle = `rgb(${fillColor.join(", ")})`;
    textCtx.lineWidth = lyricsBlock.fontStroke * 2 * EXPAND_RATE;

    const xPos =
      currX + getTextOffset(textCtx, glyphChar.char, glyphChar.width);

    drawTextToCanvas(
      textCtx,
      lyricsBlock.fontSize,
      lyricsBlock.fontStroke,
      xPos,
      getLyricsBlockLineInnerYPos(lyricsBlock),
      glyphChar.char,
    );

    currX += glyphChar.width;
  }
}

function drawFuriganaTextToCanvas(
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: LyricsBlock,
  lineNum: number,
  isPreFill: boolean,
): void {
  const lyricsLine = lyricsBlock.lyricsLines[lineNum];

  for (const furiganaBlock of lyricsLine.furigana) {
    let currX = furiganaBlock.xPos;

    const fillColor = isPreFill
      ? furiganaBlock.preFillColor
      : furiganaBlock.postFillColor;
    textCtx.fillStyle = `rgb(${fillColor.join(", ")})`;

    for (const unicodeChar of furiganaBlock.chars) {
      drawTextToCanvas(
        textCtx,
        RUBY_FONT_SIZE,
        RUBY_FONT_STROKE,
        currX,
        0,
        unicodeChar,
      );

      currX += RUBY_FONT_SIZE;
    }
  }
}

function drawRomajiTextToCanvas(
  textCtx: CanvasRenderingContext2D,
  lyricsBlock: LyricsBlock,
  lineNum: number,
  isPreFill: boolean,
): void {
  const lyricsLine = lyricsBlock.lyricsLines[lineNum];

  setTextContextFontSize(textCtx, settings.ROMAJI_FONT_SIZE);
  textCtx.lineWidth = settings.ROMAJI_FONT_STROKE * 2;

  const sortedRomaji = lyricsLine.romaji.sort((a, b) => a.xPos - b.xPos);

  for (const romajiBlock of sortedRomaji) {
    const fillColor = isPreFill
      ? romajiBlock.preFillColor
      : romajiBlock.postFillColor;
    textCtx.fillStyle = `rgb(${fillColor.join(", ")})`;

    const xPos = romajiBlock.xPos;
    const xOff = getRomajiTextOffset(
      textCtx,
      romajiBlock.phrase,
      romajiBlock.sourceWidth,
    );

    drawTextToCanvas(
      textCtx,
      settings.ROMAJI_FONT_SIZE,
      settings.ROMAJI_FONT_STROKE,
      xPos + xOff,
      lineNum * getLyricsBlockLineHeight(lyricsBlock),
      romajiBlock.phrase,
    );
  }
}

function createLyricsLineTextures(
  gl: WebGL2RenderingContext,
  lyricsData: LyricsBlock[],
  isRomaji: boolean,
): LyricsLineTextures[] {
  const textCtx = document.createElement("canvas").getContext("2d");
  invariant(textCtx);

  const lyricsLineTextures = [];

  for (const lyricsBlock of lyricsData) {
    for (let lineNum = 0; lineNum < lyricsBlock.lyricsLines.length; lineNum++) {
      const preTexture = createLyricsLineTexture(
        gl,
        textCtx,
        lyricsBlock,
        lineNum,
        lyricsBlock.preBorder,
        isRomaji,
        true,
      );

      const postTexture = createLyricsLineTexture(
        gl,
        textCtx,
        lyricsBlock,
        lineNum,
        lyricsBlock.postBorder,
        isRomaji,
        false,
      );

      lyricsLineTextures.push({ preTexture, postTexture });
    }
  }

  textCtx.canvas.remove();

  return lyricsLineTextures;
}

function getScrollXPosAbsolute(
  lyricsBlock: LyricsBlock,
  lineNum: number,
  refreshTime: number,
): number {
  const lyricsLine = lyricsBlock.lyricsLines[lineNum];
  const scrollEvents = lyricsLine.scrollEvents as JoysoundScrollEventAbsolute[];

  let xOff = 0;

  // XXX: This is a hack to handle edge cases where romaji text is off frame.
  if (scrollEvents[0] && refreshTime < scrollEvents[0].startTime) {
    return 0;
  }

  for (let i = 0; i < scrollEvents.length; i++) {
    const currScrollEvent = scrollEvents[i];

    if (refreshTime < currScrollEvent.startTime) {
      break;
    }

    let nextScrollEvent = null;

    if (i < scrollEvents.length - 1) {
      nextScrollEvent = scrollEvents[i + 1];
    }

    if (!nextScrollEvent || refreshTime < nextScrollEvent.startTime) {
      xOff +=
        (currScrollEvent.speed * (refreshTime - currScrollEvent.startTime)) /
        1000;
    } else {
      xOff +=
        (currScrollEvent.speed *
          (nextScrollEvent.startTime - currScrollEvent.startTime)) /
        1000;
    }
  }

  return lyricsBlock.xPos + xOff;
}

function getScrollXPosRelative(
  lyricsBlock: LyricsBlock,
  lineNum: number,
  refreshTime: number,
): number {
  const lyricsLine = lyricsBlock.lyricsLines[lineNum];
  let xOff = 0;

  for (const scrollEvent of lyricsLine.scrollEvents as JoysoundScrollEventRelative[]) {
    if (refreshTime < scrollEvent.startTime) {
      break;
    }

    let width = 0;

    for (let j = scrollEvent.charStartIdx; j < scrollEvent.charEndIdx; j++) {
      width += lyricsLine.chars[j].width;
    }

    xOff +=
      Math.min(
        (refreshTime - scrollEvent.startTime) /
          (scrollEvent.endTime - scrollEvent.startTime),
        1,
      ) * width;
  }

  return lyricsBlock.xPos + xOff;
}

function drawTitle(
  gl: WebGL2RenderingContext,
  glBuffers: JoysoundDisplayBuffers,
  titleTexture: WebGLTexture,
): void {
  const scrollArray = new Float32Array(Array(6).fill(0));

  const positions = quadToTriangles(
    0,
    0,
    settings.SCREEN_WIDTH * EXPAND_RATE_X,
    settings.SCREEN_HEIGHT * EXPAND_RATE_Y,
  );

  drawLyricsTexture(gl, glBuffers, titleTexture, positions, scrollArray, false);
}

function drawLyricsTexture(
  gl: WebGL2RenderingContext,
  glBuffers: JoysoundDisplayBuffers,
  texture: WebGLTexture,
  positions: number[],
  scrollArray: Float32Array,
  isPostTexture: boolean,
) {
  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.scroll);
  gl.bufferData(gl.ARRAY_BUFFER, scrollArray, gl.STATIC_DRAW);

  const scrollTypeArray = new Float32Array(
    Array(6).fill(isPostTexture ? 1.0 : 0.0),
  );

  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.scrollType);
  gl.bufferData(gl.ARRAY_BUFFER, scrollTypeArray, gl.STATIC_DRAW);

  const texCoordArray = new Float32Array(quadToTriangles(0.0, 0.0, 1.0, 1.0));

  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.texCoord);
  gl.bufferData(gl.ARRAY_BUFFER, texCoordArray, gl.STATIC_DRAW);

  gl.bindTexture(gl.TEXTURE_2D, texture);

  gl.bindBuffer(gl.ARRAY_BUFFER, glBuffers.position);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

  gl.drawArrays(gl.TRIANGLES, 0, positions.length / 2);
}

function getScrollXPos(
  lyricsBlock: LyricsBlock,
  lineNum: number,
  refreshTime: number,
  xOff: number,
): number {
  let scrollXPos =
    lyricsBlock.scrollStyle === LyricsScrollStyle.ABSOLUTE
      ? Math.floor(getScrollXPosAbsolute(lyricsBlock, lineNum, refreshTime))
      : Math.floor(getScrollXPosRelative(lyricsBlock, lineNum, refreshTime));

  if (scrollXPos === lyricsBlock.xPos) {
    return lyricsBlock.xPos;
  }

  scrollXPos += xOff;
  scrollXPos += lyricsBlock.fontStroke;

  return scrollXPos;
}

function drawLyricsLine(
  gl: WebGL2RenderingContext,
  glBuffers: JoysoundDisplayBuffers,
  lyricsLinePreTexture: WebGLTexture,
  lyricsLinePostTexture: WebGLTexture,
  lyricsBlock: LyricsBlock,
  lineNum: number,
  refreshTime: number,
) {
  const rectWidth = getLyricsLineWidth(lyricsBlock, lineNum);
  const rectHeight = getLyricsBlockLineHeight(lyricsBlock);
  const xOff = (getLyricsBlockWidth(lyricsBlock) - rectWidth) / 2;

  // TODO: Render lyricsBlock properly when yPos is negative
  // TODO: Fix currY, shouldn't be subtracting random values...

  const currX = lyricsBlock.xPos + xOff;
  const currY =
    lyricsBlock.yPos + getLyricsBlockLineHeight(lyricsBlock) * lineNum;

  const positions = quadToTriangles(
    (currX - settings.TEXT_PADDING) * EXPAND_RATE_X,
    currY * EXPAND_RATE_Y,
    (currX - settings.TEXT_PADDING + rectWidth) * EXPAND_RATE_X,
    (currY + rectHeight) * EXPAND_RATE_Y,
  );

  /*
  const positions = quadToTriangles(
    (currX - settings.TEXT_PADDING) * EXPAND_RATE_X,
    (currY - settings.TEXT_PADDING) * EXPAND_RATE_Y,
    (currX - settings.TEXT_PADDING + rectWidth) * EXPAND_RATE_X,
    (currY - settings.TEXT_PADDING + rectHeight) * EXPAND_RATE_Y,
  );
   */

  const scrollXPos = getScrollXPos(lyricsBlock, lineNum, refreshTime, xOff);
  const scrollArray = new Float32Array(
    Array(6).fill(scrollXPos * EXPAND_RATE_X),
  );

  if (scrollXPos <= currX + rectWidth) {
    drawLyricsTexture(
      gl,
      glBuffers,
      lyricsLinePreTexture,
      positions,
      scrollArray,
      false,
    );
  }

  if (scrollXPos >= currX) {
    drawLyricsTexture(
      gl,
      glBuffers,
      lyricsLinePostTexture,
      positions,
      scrollArray,
      true,
    );
  }
}

export default function JoysoundRenderer(props: {
  lyricsData: LyricsData;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isRomaji: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRequestRef = useRef<number>(0);

  const updateSize = () => {
    const canvasElement = canvasRef.current;
    invariant(canvasElement);

    canvasElement.width = canvasElement.clientWidth * window.devicePixelRatio;
    canvasElement.height = canvasElement.clientHeight * window.devicePixelRatio;

    // XXX: Global variables but it works
    EXPAND_RATE = Math.min(
      canvasElement.width / settings.SCREEN_WIDTH,
      canvasElement.height / settings.SCREEN_HEIGHT,
    );

    EXPAND_RATE_X = canvasElement.width / settings.SCREEN_WIDTH;
    EXPAND_RATE_Y = canvasElement.height / settings.SCREEN_HEIGHT;

    const gl = canvasElement.getContext("webgl2", {
      antialias: false,
      premultipliedAlpha: false,
    });

    invariant(gl);
    gl.viewport(0, 0, canvasElement.width, canvasElement.height);
  };

  useEffect(() => {
    const refresh = async () => {
      console.log("refresh");

      updateSize();
      window.addEventListener("resize", updateSize);

      const joysoundData = props.lyricsData;

      const metadata = joysoundData.metadata;
      const lyricsData = joysoundData.lyrics;

      if (metadata.captionCode !== "") {
        preprocessLyricsData(lyricsData, metadata.captionCode);
      }

      invariant(canvasRef.current);
      const gl = canvasRef.current.getContext("webgl2", {
        antialias: false,
        premultipliedAlpha: false,
      });
      invariant(gl);

      const titleTexture = createTitleTexture(gl, metadata, props.isRomaji);

      const lyricsLineTextures = createLyricsLineTextures(
        gl,
        lyricsData,
        props.isRomaji,
      );

      const vertexShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
      const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);

      const program = createProgram(gl, vertexShader, fragmentShader);

      const positionAttributeLocation = gl.getAttribLocation(
        program,
        "a_position",
      );

      const texCoordLocation = gl.getAttribLocation(program, "a_texCoord");
      const scrollLocation = gl.getAttribLocation(program, "a_scroll");
      const scrollTypeLocation = gl.getAttribLocation(program, "a_scrollType");
      const resolutionUniformLocation = gl.getUniformLocation(
        program,
        "u_resolution",
      );

      const positionBuffer = gl.createBuffer();
      const texCoordBuffer = gl.createBuffer();
      const scrollBuffer = gl.createBuffer();
      const scrollTypeBuffer = gl.createBuffer();

      invariant(positionBuffer);
      invariant(texCoordBuffer);
      invariant(scrollBuffer);
      invariant(scrollTypeBuffer);

      const glBuffers: JoysoundDisplayBuffers = {
        position: positionBuffer,
        texCoord: texCoordBuffer,
        scroll: scrollBuffer,
        scrollType: scrollTypeBuffer,
      };

      function draw() {
        invariant(gl);
        invariant(props.videoRef.current);

        const refreshTime =
          props.videoRef.current.currentTime * 1000 + TIMING_OFFSET;
        invariant(refreshTime);

        gl.clearColor(0.0, 0.0, 0.0, 0.2);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(
          gl.SRC_ALPHA,
          gl.ONE_MINUS_SRC_ALPHA,
          gl.ONE,
          gl.ONE_MINUS_SRC_ALPHA,
        );

        gl.useProgram(program);

        gl.enableVertexAttribArray(positionAttributeLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.vertexAttribPointer(
          positionAttributeLocation,
          2,
          gl.FLOAT,
          false,
          0,
          0,
        );

        gl.enableVertexAttribArray(texCoordLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
        gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

        gl.enableVertexAttribArray(scrollLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, scrollBuffer);
        gl.vertexAttribPointer(scrollLocation, 1, gl.FLOAT, false, 0, 0);

        gl.enableVertexAttribArray(scrollTypeLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, scrollTypeBuffer);
        gl.vertexAttribPointer(scrollTypeLocation, 1, gl.FLOAT, false, 0, 0);

        gl.uniform2f(
          resolutionUniformLocation,
          gl.canvas.width,
          gl.canvas.height,
        );

        if (
          titleTexture != null &&
          metadata != null &&
          refreshTime < metadata.fadeoutTime
        ) {
          drawTitle(gl, glBuffers, titleTexture);
        }

        drawLyrics(gl, glBuffers, lyricsLineTextures, lyricsData, refreshTime);

        animationFrameRequestRef.current = window.requestAnimationFrame(draw);
      }

      animationFrameRequestRef.current = window.requestAnimationFrame(draw);
    };

    refresh().catch(console.error);

    return () => {
      window.removeEventListener("resize", updateSize);
      window.cancelAnimationFrame(animationFrameRequestRef.current);
    };
  }, [props.lyricsData, props.isRomaji]);

  return <canvas ref={canvasRef} className="joysoundDisplay"></canvas>;
}

function drawLyrics(
  gl: WebGL2RenderingContext,
  glBuffers: JoysoundDisplayBuffers,
  lyricsLineTextures: LyricsLineTextures[],
  lyricsData: LyricsBlock[],
  refreshTime: number,
) {
  let lyricsLineTexturesIdx = 0;

  for (const lyricsBlock of lyricsData) {
    if (
      refreshTime < lyricsBlock.fadeinTime ||
      refreshTime >= lyricsBlock.fadeoutTime
    ) {
      lyricsLineTexturesIdx += lyricsBlock.lyricsLines.length;

      continue;
    }

    for (let lineNum = 0; lineNum < lyricsBlock.lyricsLines.length; lineNum++) {
      drawLyricsLine(
        gl,
        glBuffers,
        lyricsLineTextures[lyricsLineTexturesIdx].preTexture,
        lyricsLineTextures[lyricsLineTexturesIdx].postTexture,
        lyricsBlock,
        lineNum,
        refreshTime,
      );

      lyricsLineTexturesIdx += 1;
    }
  }
}
