// 絵柄のルール：フラット、太い輪郭、明るい色を数色、簡単な表情。
// 遊びが変わっても雰囲気がそろうよう、色と線の太さはここから使う。

export const palette = {
  /** 背景（暗めにすると投影で映える） */
  bg: 0x1b1f3b,
  bgLight: 0x2a3060,
  /** 輪郭 */
  ink: 0x1a1a2e,
  white: 0xffffff,
  red: 0xff5a5f,
  orange: 0xff9f1c,
  yellow: 0xffd23f,
  green: 0x3ddc97,
  blue: 0x3fa7ff,
  purple: 0x9b5de5,
  pink: 0xff7eb6,
};

/** 遊びで使う明るい色（順番に使うとバランスがよい） */
export const brights = [palette.red, palette.yellow, palette.blue, palette.green, palette.orange, palette.purple, palette.pink];

/** 画面の大きさに合わせた輪郭の太さ */
export function lineWidth(screenHeight: number): number {
  return Math.max(3, Math.round(screenHeight / 120));
}

/** 文字のスタイル（丸く太い字） */
// Mac は丸ゴシック。Windows には丸ゴシックが入っていないので、読みやすいゴシック（BIZ UDPゴシック → 游ゴシック → メイリオ）にする
export const fontFamily = '"Hiragino Maru Gothic ProN", "Rounded Mplus 1c", "Arial Rounded MT Bold", "BIZ UDPGothic", "Yu Gothic UI", "Meiryo", sans-serif';
