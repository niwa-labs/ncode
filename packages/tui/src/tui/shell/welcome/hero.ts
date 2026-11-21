import { visibleWidth } from '../../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import { centerToWidth } from '../frame.js';
import {
  NCODE_TERMINAL_MICRO_WORDMARK,
  NCODE_TERMINAL_WORDMARK,
  MINIMAX_CODE_WELCOME_DESIGN,
} from './design.js';

export function renderTuiWelcomeHero(width: number): string[] {
  const { wordmarkMinWidth, microMinWidth, fallbackTitle } = MINIMAX_CODE_WELCOME_DESIGN.hero;
  const source =
    width >= wordmarkMinWidth
      ? NCODE_TERMINAL_WORDMARK
      : width >= microMinWidth
        ? NCODE_TERMINAL_MICRO_WORDMARK
        : [fallbackTitle];
  const isCharacterWordmark = source.length > 1;
  const sourceWidth = Math.max(...source.map((line) => visibleWidth(line)));
  const gradient = [
    colors.wordmarkHighlight,
    colors.wordmarkHighlight,
    colors.brand,
    colors.brand,
    colors.wordmarkShadow,
    colors.wordmarkShadow,
  ];

  return source.map((line, index) => {
    const canvasLine = line + ' '.repeat(Math.max(0, sourceWidth - visibleWidth(line)));
    const color = isCharacterWordmark ? (gradient[index] ?? colors.brand) : colors.brand;
    return centerToWidth(chalk.bold.hex(color)(canvasLine), width);
  });
}
