/* tslint:disable:no-bitwise */

import {
  JoysoundLyricsChar,
  JoysoundLyricsFurigana,
  JoysoundScrollEventRelative,
  LyricsBlock,
  LyricsData,
  LyricsLine,
  LyricsScrollStyle,
} from "./joysoundParser";

interface LyricsTiming {
  lyricsBlockTextList: LyricsText[][];
  lyricsBlock: LyricsBlock;
  order: number;
  line: number;
}

interface LyricsText {
  color: number[];
  text: string;
  furigana: LyricsFurigana[];
}

interface LyricsTextInterval {
  interval: number[];
  color: number[];
}

interface LyricsFurigana {
  kanjiIndex: number;
  text: string;
}

interface CueTimings {
  startTime: number;
  endTime: number;
}

interface CueProperties {
  line: number;
  position: number;
}

interface CuePayloadLineParserResult {
  nextState: string;
  lyricsTextList: LyricsText[];
}

const DEFAULT_TEXT_COLOR = [255, 255, 255];

const VTT_MAIN_FONT_SIZE = 44;
const VTT_MAIN_FONT_STROKE = 4;

export default function parseVtt(
  vttFile: string,
  captionCode: string,
): LyricsData {
  let currLine = 0;

  const rawLyricsToLyricsTimings: Map<string, LyricsTiming[]> = new Map();
  const cueClassToColor: Map<string, number[]> = new Map();

  const lines = vttFile.split("\n");

  while (currLine < lines.length) {
    if (lines[currLine].indexOf("::cue") !== -1) {
      currLine += parseColorClass(lines, currLine, cueClassToColor);
      continue;
    }

    if (lines[currLine].indexOf("-->") !== -1) {
      currLine += parseCueBlock(
        lines,
        currLine,
        rawLyricsToLyricsTimings,
        cueClassToColor,
      );

      continue;
    }

    currLine += 1;
  }

  const lyricsBlocks: LyricsBlock[] = Array.from(
    rawLyricsToLyricsTimings.values(),
  )
    .flat()
    .sort(sortLyricsTimingByLinePos)
    .map((timing) => timing.lyricsBlock);

  for (const lyricsBlock of lyricsBlocks) {
    padScrollEventsForLyricsBlock(lyricsBlock);
  }

  return {
    metadata: { captionCode, fadeoutTime: 0 },
    lyrics: lyricsBlocks,
  };
}

function parseColorClass(
  lines: string[],
  currLine: number,
  cueClassToColor: Map<string, number[]>,
): number {
  let offset = 0;
  let className = null;
  let rgbValue = null;

  while (currLine < lines.length) {
    if (lines[currLine + offset].indexOf("}") !== -1) {
      offset += 1;
      break;
    }

    const classRegexMatch =
      lines[currLine + offset].match(/::cue\(c\.([^)]+)\)/);

    if (classRegexMatch !== null) {
      className = classRegexMatch[1];
    }

    const rgbRegexMatch = lines[currLine + offset].match(
      /rgb\((\d+)\s*,\s*(\d+)\s*,(\d+)\s*\)/,
    );

    if (rgbRegexMatch !== null) {
      rgbValue = rgbRegexMatch
        .slice(1, 4)
        .map((rgbString) => parseInt(rgbString, 10));
    }

    offset += 1;
  }

  if (className !== null && rgbValue !== null) {
    cueClassToColor.set(className, rgbValue);
  }

  return offset;
}

function parseCueTimings(line: string): CueTimings {
  const splitLine = line.split(" ");

  const startTime = timestampToMs(splitLine[0]);
  const endTime = timestampToMs(splitLine[2]);

  return {
    startTime,
    endTime,
  };
}

function parseCueProperties(line: string): CueProperties {
  const splitLine = line.split(" ");
  const cueProperties = getDefaultCueProperties();

  if (splitLine.length > 3) {
    processCueProperties(
      splitLine.splice(3, splitLine.length - 1),
      cueProperties,
    );
  }

  return cueProperties;
}

function parseCueBlock(
  lines: string[],
  currLine: number,
  rawLyricsToLyricsTimings: Map<string, LyricsTiming[]>,
  cueClassToColor: Map<string, number[]>,
): number {
  const cueTimings = parseCueTimings(lines[currLine]);
  const cueProperties = parseCueProperties(lines[currLine]);
  const cuePayloadLines = extractCuePayloadLines(lines, currLine);

  const lyricsBlockTextList = parseCuePayloadLines(
    cuePayloadLines,
    cueClassToColor,
  );

  const lyricsBlockRawText = lyricsBlockTextList
    .map((lyricsLineTextList) =>
      lyricsLineTextList.map((lyricsText) => lyricsText.text).join(""),
    )
    .join("");

  const lyricsColors = getColorsFromLyricsBlockTextList(lyricsBlockTextList);

  const lyricsTimings = rawLyricsToLyricsTimings.get(lyricsBlockRawText) ?? [];
  let existingLyricsTiming: LyricsTiming | null = getExistingLyricsTiming(
    cueTimings,
    lyricsTimings,
  );

  if (existingLyricsTiming === null) {
    const newLyricsTiming = createLyricsTiming(
      lyricsBlockTextList,
      cueTimings,
      cueProperties,
      currLine + 1,
    );

    rawLyricsToLyricsTimings.set(lyricsBlockRawText, [
      ...lyricsTimings,
      newLyricsTiming,
    ]);

    existingLyricsTiming = newLyricsTiming;
  } else if (
    cueTimings.startTime >= existingLyricsTiming.lyricsBlock.fadeinTime &&
    cueTimings.endTime <= existingLyricsTiming.lyricsBlock.fadeoutTime
  ) {
    return lyricsBlockTextList.length + 1;
  }

  const existingLyricsBlock = existingLyricsTiming.lyricsBlock;
  existingLyricsBlock.fadeoutTime = cueTimings.endTime;

  for (let lineNum = 0; lineNum < lyricsBlockTextList.length; lineNum++) {
    if (lyricsBlockTextList[lineNum].length === 0) {
      continue;
    }

    parseCuePayload(
      lyricsBlockTextList[lineNum],
      lyricsColors,
      lineNum,
      existingLyricsTiming,
      cueTimings,
    );
  }

  return lyricsBlockTextList.length + 1;
}

function parseCuePayload(
  lyricsLineTextList: LyricsText[],
  lyricsColors: number[][],
  lineNum: number,
  existingLyricsTiming: LyricsTiming,
  cueTimings: CueTimings,
): void {
  const lyricsBuffer = lyricsLineTextList.map((lyricsText) => lyricsText.text);
  const lyricsFurigana = lyricsLineTextList.map(
    (lyricsText) => lyricsText.furigana,
  );
  const flatLyricsFurigana = lyricsFurigana.flat();

  const newLyricsLine = createLyricsLine(
    lyricsLineTextList,
    lyricsColors,
    lineNum,
    flatLyricsFurigana,
    mapRawLyricsIndexToFuriganaIndex(lyricsBuffer, lyricsFurigana),
  );

  if (lineNum === existingLyricsTiming.lyricsBlock.lyricsLines.length) {
    existingLyricsTiming.lyricsBlock.lyricsLines.push(newLyricsLine);
    return;
  }

  const existingLyricsBlock = existingLyricsTiming.lyricsBlock;

  const oldLyricsLineTextList =
    existingLyricsTiming.lyricsBlockTextList[lineNum];

  existingLyricsTiming.lyricsBlockTextList[lineNum] = lyricsLineTextList;

  const diff = getLyricsLineTextListDiffIndicies(
    oldLyricsLineTextList,
    lyricsLineTextList,
  );

  if (diff[0] < diff[1]) {
    const currLyricsLine = existingLyricsBlock.lyricsLines[lineNum];

    currLyricsLine.scrollEvents.push({
      startTime: cueTimings.startTime,
      endTime: cueTimings.endTime,
      charStartIdx: diff[0],
      charEndIdx: diff[1],
    });

    if (diff[1] === currLyricsLine.chars.length) {
      updatePostFillColor(lyricsLineTextList, currLyricsLine);
    }
  }
}

function updatePostFillColor(
  lyricsLineTextList: LyricsText[],
  currLyricsLine: LyricsLine,
): void {
  let charIdx = 0;

  for (const lyricsText of lyricsLineTextList) {
    for (const _ of lyricsText.text) {
      const lyricsChar = currLyricsLine.chars[charIdx];
      lyricsChar.postFillColor = lyricsText.color;

      if (lyricsChar.furiganaIndex >= 0) {
        currLyricsLine.furigana[lyricsChar.furiganaIndex].postFillColor =
          lyricsText.color;
      }

      charIdx += 1;
    }
  }
}

function getLyricsCharsAndFuriganaForLyricsLine(
  lyricsLineTextList: LyricsText[],
  lyricsColors: number[][],
  rawLyricsIndexToFuriganaIndex: Map<number, number>,
  lyricsFuriganaList: LyricsFurigana[],
): { chars: JoysoundLyricsChar[]; furigana: JoysoundLyricsFurigana[] } {
  const lyricsChars: JoysoundLyricsChar[] = [];
  const furigana: JoysoundLyricsFurigana[] = [];

  let idx = 0;

  for (const lyricsText of lyricsLineTextList) {
    for (const char of lyricsText.text) {
      const furiganaIndex = rawLyricsIndexToFuriganaIndex.get(idx) ?? -1;

      const lyricsChar = {
        font: 0,
        width: -1,
        char,
        preFillColor: lyricsColors[lyricsColors.length - 1],
        postFillColor: lyricsText.color,
        furiganaIndex,
      };

      lyricsChars.push(lyricsChar);

      if (furiganaIndex >= 0) {
        const furiganaChar = {
          length: lyricsFuriganaList[furiganaIndex].text.length,
          xPos: -1,
          chars: lyricsFuriganaList[furiganaIndex].text.split(""),
          preFillColor: lyricsColors[lyricsColors.length - 1],
          postFillColor: lyricsText.color,
        };

        furigana.push(furiganaChar);
      }

      idx += 1;
    }
  }

  return {
    chars: lyricsChars,
    furigana,
  };
}

function extractCuePayloadLines(lines: string[], currLine: number): string[] {
  const cuePayloadLines: string[] = [];

  while (lines[currLine + cuePayloadLines.length + 1].trim().length > 0) {
    let lineText = lines[currLine + cuePayloadLines.length + 1];
    lineText = lineText.replace("&amp;", "&");

    cuePayloadLines.push(lineText);
  }

  return cuePayloadLines;
}

function isFinishedScrolling(lyricsLine: LyricsLine): boolean {
  if (lyricsLine.scrollEvents.length === 0) {
    return false;
  }

  const idx = lyricsLine.scrollEvents.length - 1;
  const lastScrollEvent = lyricsLine.scrollEvents[
    idx
  ] as JoysoundScrollEventRelative;

  return lastScrollEvent.charEndIdx === lyricsLine.chars.length;
}

function getExistingLyricsTiming(
  cueTimings: CueTimings,
  lyricsTimings: LyricsTiming[],
): LyricsTiming | null {
  for (const lyricsTiming of lyricsTimings) {
    /* If the fadeinTime of an existing lyrics block with the same
     * raw text is the same as the start time of the current lyrics block,
     * then we assume they are duplicate lyrics blocks.
     */
    if (
      cueTimings.startTime >= lyricsTiming.lyricsBlock.fadeinTime &&
      cueTimings.endTime <= lyricsTiming.lyricsBlock.fadeoutTime
    ) {
      return lyricsTiming;
    }

    /* If the fadeoutTime of an existing lyrics block with the same
     * raw text is the same as the start time of the current lyrics block,
     * then we assume they are part of the same lyrics block.
     */
    if (lyricsTiming.lyricsBlock.fadeoutTime !== cueTimings.startTime) {
      continue;
    }

    /* If every line of the block has a list of scroll events that has all
     * the scroll events fully set up, then the current lyrics block is not
     * a part of this lyrics block.
     */
    if (lyricsTiming.lyricsBlock.lyricsLines.every(isFinishedScrolling)) {
      continue;
    }

    return lyricsTiming;
  }

  return null;
}

function getColorsFromLyricsBlockTextList(
  lyricsBlockTextList: LyricsText[][],
): number[][] {
  const lyricsColorOrderedSet: number[][] = [];

  const lyricsColors = lyricsBlockTextList
    .map((lyricsLineTextList) =>
      lyricsLineTextList.map((lyricsText) => lyricsText.color),
    )
    .flat();

  for (const lyricsColor of lyricsColors) {
    let hasColorInSet = false;

    // TODO: Maybe I need a Color class...
    for (const existingLyricsColor of lyricsColorOrderedSet) {
      if (
        lyricsColor[0] === existingLyricsColor[0] &&
        lyricsColor[1] === existingLyricsColor[1] &&
        lyricsColor[2] === existingLyricsColor[2]
      ) {
        hasColorInSet = true;
        break;
      }
    }

    if (hasColorInSet) {
      continue;
    }

    lyricsColorOrderedSet.push(lyricsColor);
  }

  return lyricsColorOrderedSet;
}

function createLyricsTiming(
  lyricsBlockTextList: LyricsText[][],
  cueTimings: CueTimings,
  cueProperties: CueProperties,
  order: number,
): LyricsTiming {
  return {
    lyricsBlockTextList,
    lyricsBlock: createLyricsBlock(
      cueTimings.startTime,
      cueTimings.endTime,
      cueProperties,
    ),
    order,
    line: cueProperties.line,
  };
}

function createLyricsLine(
  lyricsLineTextList: LyricsText[],
  lyricsColors: number[][],
  lineNum: number,
  flatLyricsFurigana: LyricsFurigana[],
  rawLyricsIndexToFuriganaIndex: Map<number, number>,
): LyricsLine {
  const charsAndFurigana = getLyricsCharsAndFuriganaForLyricsLine(
    lyricsLineTextList,
    lyricsColors,
    rawLyricsIndexToFuriganaIndex,
    flatLyricsFurigana,
  );

  return {
    scrollEvents: [],
    chars: charsAndFurigana.chars,
    furigana: charsAndFurigana.furigana,
    romaji: [],
    line: lineNum,
  };
}

function mapRawLyricsIndexToFuriganaIndex(
  lyricsBuffer: string[],
  lyricsFurigana: LyricsFurigana[][],
): Map<number, number> {
  const rawLyricsIndexToFuriganaText: Map<number, number> = new Map();
  let offset = 0;
  let furiganaIndex = 0;

  for (let i = 0; i < lyricsBuffer.length; i++) {
    for (const furigana of lyricsFurigana[i]) {
      rawLyricsIndexToFuriganaText.set(
        furigana.kanjiIndex + offset,
        furiganaIndex,
      );

      furiganaIndex += 1;
    }

    offset += lyricsBuffer[i].length;
  }

  return rawLyricsIndexToFuriganaText;
}

function getDefaultCueProperties(): CueProperties {
  return {
    position: 0,
    line: 95,
  };
}

function processCueProperties(
  propertyStringArray: string[],
  cueProperties: CueProperties,
) {
  for (const propertyString of propertyStringArray) {
    processCueBoxPosition(cueProperties, propertyString);
    processCueBoxLine(cueProperties, propertyString);
  }
}

function processCueBoxPosition(
  cueProperties: CueProperties,
  propertyString: string,
): void {
  const matchset = propertyString.match(/^position\s*:\s*(\d+)%?/);

  if (!matchset) {
    return;
  }

  cueProperties.position = parseInt(matchset[1], 10);
}

function processCueBoxLine(
  cueProperties: CueProperties,
  propertyString: string,
): void {
  const matchset = propertyString.match(/^line\s*:\s*(\d+)%?/);

  if (!matchset) {
    return;
  }

  cueProperties.line = parseInt(matchset[1], 10);
}

function createLyricsBlock(
  fadeinTime: number,
  fadeoutTime: number,
  cueProperties: CueProperties,
): LyricsBlock {
  return {
    xPos: -1,
    yPos: cueProperties.line < 50 ? -1 : -2,
    preBorder: [8, 8, 8],
    postBorder: [254, 254, 254],
    lyricsLines: [],
    scrollStyle: LyricsScrollStyle.RELATIVE,
    fadeinTime,
    fadeoutTime,
    fontSize: VTT_MAIN_FONT_SIZE,
    fontStroke: VTT_MAIN_FONT_STROKE,
  };
}

function timestampToMs(timestamp: string) {
  let ms = 0;

  if (timestamp.length === 12) {
    ms += 1000 * 60 * 60 * Number(timestamp.slice(0, 2));
    timestamp = timestamp.slice(3, 12);
  }

  ms += 1000 * 60 * Number(timestamp.slice(0, 2));
  ms += 1000 * Number(timestamp.slice(3, 5));
  ms += Number(timestamp.slice(6, 9));

  return ms;
}

/*
<c=A>The quick blue fox
jumped</c><c=B> over the
lazy dog.</c>

  [
  [{text: "The quick brown fox", color: A}],
    [{text: "jumped", color: A}, {text: " over the", color: B}],
    [{text: "lazy dog", color: B}],
  ];
*/

function parseCuePayloadLine(
  cuePayloadLine: string,
  cueClassToColor: Map<string, number[]>,
  initialState: string,
  lyricsColor: number[],
): CuePayloadLineParserResult {
  let lyricsBuffer: LyricsText[] = [];
  let furiganaList: LyricsFurigana[] = [];

  let state = initialState;
  let textBuffer = "";
  let classBuffer = "";
  let furiganaBuffer = "";

  let idx = 0;

  while (idx < cuePayloadLine.length) {
    switch (state) {
      case "data":
        if (cuePayloadLine[idx] === "<") {
          if (textBuffer.length > 0) {
            lyricsBuffer.push({
              color: lyricsColor,
              text: textBuffer,
              furigana: furiganaList,
            });
          }

          textBuffer = "";
          furiganaList = [];

          state = "cueSpanTag";
        } else if (
          cuePayloadLine[idx] === "(" &&
          textBuffer.length > 0 &&
          textBuffer[textBuffer.length - 1] !== " "
        ) {
          state = "furigana";
        } else if (!cuePayloadLine[idx].match(/[\u200B-\u200D\uFEFF]/g)) {
          textBuffer += cuePayloadLine[idx];
        }

        break;
      case "cueSpanTag":
        if (
          idx > 0 &&
          cuePayloadLine[idx - 1] === "c" &&
          cuePayloadLine[idx] === "."
        ) {
          state = "cueSpanClass";
        } else if (cuePayloadLine[idx] === ">") {
          state = "data";
        }

        break;
      case "cueSpanClass":
        if (cuePayloadLine[idx] === ">") {
          lyricsColor = cueClassToColor.get(classBuffer) ?? DEFAULT_TEXT_COLOR;
          classBuffer = "";
          state = "data";
        } else {
          classBuffer += cuePayloadLine[idx];
        }

        break;
      case "furigana":
        if (cuePayloadLine[idx] === ")") {
          furiganaList.push({
            kanjiIndex: textBuffer.length - 1,
            text: furiganaBuffer,
          });

          furiganaBuffer = "";
          state = "data";
        } else {
          furiganaBuffer += cuePayloadLine[idx];
        }

        break;
    }
    idx += 1;
  }

  if (textBuffer.length > 0) {
    lyricsColor = cueClassToColor.get(classBuffer) ?? DEFAULT_TEXT_COLOR;

    lyricsBuffer.push({
      color: lyricsColor,
      text: textBuffer,
      furigana: furiganaList,
    });
  }

  lyricsBuffer = mergeSameColorLyrics(lyricsBuffer);
  trimLyricsBufferStart(lyricsBuffer);
  trimLyricsBufferEnd(lyricsBuffer);

  return {
    lyricsTextList: lyricsBuffer,
    nextState: state,
  };
}

function parseCuePayloadLines(
  cuePayloadLines: string[],
  cueClassToColor: Map<string, number[]>,
): LyricsText[][] {
  const lyricsLines: LyricsText[][] = [];

  let state = "data";

  for (const cuePayloadLine of cuePayloadLines) {
    const parserResult = parseCuePayloadLine(
      cuePayloadLine,
      cueClassToColor,
      state,
      DEFAULT_TEXT_COLOR,
    );

    lyricsLines.push(parserResult.lyricsTextList);
    state = parserResult.nextState;
  }

  return lyricsLines;
}

function trimLyricsBufferStart(lyricsBuffer: LyricsText[]): void {
  while (lyricsBuffer.length > 0) {
    const oldTextLength = lyricsBuffer[0].text.length;
    lyricsBuffer[0].text = lyricsBuffer[0].text.trimStart();

    // Need to update furigana as well... there should be an easier way to do this...
    if (lyricsBuffer[0].text.length < oldTextLength) {
      for (const furigana of lyricsBuffer[0].furigana) {
        furigana.kanjiIndex -= oldTextLength - lyricsBuffer[0].text.length;
      }
    }

    if (lyricsBuffer[0].text.length > 0) {
      break;
    }

    lyricsBuffer.splice(0, 1);
  }
}

function trimLyricsBufferEnd(lyricsBuffer: LyricsText[]): void {
  let idx = lyricsBuffer.length - 1;

  while (idx >= 0) {
    lyricsBuffer[idx].text = lyricsBuffer[idx].text.trimEnd();

    if (lyricsBuffer[idx].text.length > 0) {
      break;
    }

    lyricsBuffer.splice(idx, 1);
    idx -= 1;
  }
}

function mergeSameColorLyrics(lyricsBuffer: LyricsText[]): LyricsText[] {
  if (lyricsBuffer.length === 0) {
    return lyricsBuffer;
  }

  const mergedLyricsBuffer: LyricsText[] = [lyricsBuffer[0]];

  let idx = 1;

  while (idx < lyricsBuffer.length) {
    const newLyricsText = lyricsBuffer[idx];
    const lastLyricsText = mergedLyricsBuffer[mergedLyricsBuffer.length - 1];

    if (newLyricsText.color === lastLyricsText.color) {
      const newFurigana = newLyricsText.furigana.map((furigana) => {
        return {
          ...furigana,
          kanjiIndex: furigana.kanjiIndex + lastLyricsText.text.length,
        };
      });

      lastLyricsText.text = lastLyricsText.text + newLyricsText.text;
      lastLyricsText.furigana = lastLyricsText.furigana.concat(newFurigana);
    } else {
      mergedLyricsBuffer.push(newLyricsText);
    }

    idx += 1;
  }

  return mergedLyricsBuffer;
}

function getLyricsLineTextListIntervals(
  lyricsLineTextList: LyricsText[],
): LyricsTextInterval[] {
  const intervals: LyricsTextInterval[] = [];

  let startIdx = 0;

  for (const lyricsText of lyricsLineTextList) {
    const lyricsString = lyricsText.text;
    const lyricsInterval: LyricsTextInterval = {
      color: lyricsText.color,
      interval: [startIdx, startIdx + lyricsString.length - 1],
    };

    intervals.push(lyricsInterval);
    startIdx += lyricsString.length;
  }

  return intervals;
}

/* Given two sets of lyricsBuffer arrays with the same raw text, get the raw
   text interval where they differ. They should only differ in a single
   interval and this interval should be lower inclusive, upper exclusive
   i.e. [lower, upper). Returns [rawLyrics.length, 0] when there is no diff.

   Example:
     oldLyricsBuffer: ["I wanna ", "be the guy"]
     lyricsBuffer: ["I wanna be ", "the guy"]

   Expected result: [8, 11], as the diff is "be ".
*/
function getLyricsLineTextListDiffIndicies(
  oldLyricsLineTextList: LyricsText[],
  lyricsLineTextList: LyricsText[],
): number[] {
  const oldLyricsBufferIntervals: LyricsTextInterval[] =
    getLyricsLineTextListIntervals(oldLyricsLineTextList);
  const lyricsBufferIntervals: LyricsTextInterval[] =
    getLyricsLineTextListIntervals(lyricsLineTextList);

  const maxIntervals = Math.max(
    oldLyricsBufferIntervals.length,
    lyricsBufferIntervals.length,
  );

  for (let i = 0; i < maxIntervals; i += 1) {
    const leftInterval = oldLyricsBufferIntervals[i];
    const rightInterval = lyricsBufferIntervals[i];

    if (leftInterval.interval[1] > rightInterval.interval[1]) {
      return [leftInterval.interval[0], rightInterval.interval[1] + 1];
    } else if (leftInterval.interval[1] < rightInterval.interval[1]) {
      return [leftInterval.interval[1] + 1, rightInterval.interval[1] + 1];
    } else if (leftInterval.color !== rightInterval.color) {
      return [leftInterval.interval[0], leftInterval.interval[1] + 1];
    }
  }

  // Fallback if there is no match
  return [
    lyricsBufferIntervals[lyricsBufferIntervals.length - 1].interval[1],
    0,
  ];
}

function padScrollEventsForLyricsBlock(lyricsBlock: LyricsBlock) {
  for (const lyricsLine of lyricsBlock.lyricsLines) {
    if (lyricsLine.scrollEvents.length === 0) {
      continue;
    }

    const firstScrollEvent = lyricsLine
      .scrollEvents[0] as JoysoundScrollEventRelative;

    lyricsLine.scrollEvents.unshift({
      startTime: lyricsBlock.fadeinTime,
      endTime: firstScrollEvent.startTime,
      charStartIdx: 0,
      charEndIdx: firstScrollEvent.charStartIdx,
    });

    break;
  }
}

function sortLyricsTimingByLinePos(a: LyricsTiming, b: LyricsTiming) {
  if (a.lyricsBlock.fadeinTime < b.lyricsBlock.fadeinTime) {
    return -1;
  } else if (a.lyricsBlock.fadeinTime > b.lyricsBlock.fadeinTime) {
    return 1;
  }

  // If a is on the top, then lower line, lower order
  if (a.line < 50) {
    if (a.line < b.line) {
      return -1;
    } else if (a.line > b.line) {
      return 1;
    }

    if (a.order < b.order) {
      return -1;
    } else if (a.order > b.order) {
      return 1;
    }

    return 0;
  }

  // If a is on the bottom, then render by largest line, largest order.
  if (a.line > b.line) {
    return -1;
  } else if (a.line < b.line) {
    return 1;
  }

  if (a.order > b.order) {
    return -1;
  } else if (a.order < b.order) {
    return 1;
  }

  return 0;
}
