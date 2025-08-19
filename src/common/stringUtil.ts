import Kuroshiro from "kuroshiro";

export function isKatakanaUnicodeChar(unicodeChar: string) {
  const charCode = unicodeChar.charCodeAt(0);

  return charCode >= 0x30a0 && charCode <= 0x30ff;
}

export function isKanaUnicodeChar(unicodeChar: string) {
  const charCode = unicodeChar.charCodeAt(0);

  return charCode >= 0x3040 && charCode <= 0x30ff;
}

export function isKanjiUnicodeChar(unicodeChar: string) {
  return Kuroshiro.Util.hasKanji(unicodeChar) || unicodeChar === "々";
}

export function isJapaneseUnicodeChar(unicodeChar: string) {
  return isKanaUnicodeChar(unicodeChar) || isKanjiUnicodeChar(unicodeChar);
}
