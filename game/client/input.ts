// 키 입력 → 게임 동작 매핑 (순수 함수, 단위 테스트 대상)
import type { Dir } from "../shared/types";

export type Action =
  | { type: "move"; dir: Dir }
  | { type: "attack" }
  | { type: "skill"; slot: number }
  | { type: "chat" }
  | { type: "inventory" }
  | { type: "pickup" }
  | { type: "talk" }
  | { type: "potion" }
  | { type: "close" };

const ARROWS: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

/** KeyboardEvent.code 기준으로 매핑한다(한글 입력 상태에서도 동작하도록). */
export function keyToAction(code: string): Action | null {
  if (code in ARROWS) return { type: "move", dir: ARROWS[code] };
  if (code === "Space" || code === "ControlLeft" || code === "ControlRight") return { type: "attack" };
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  if (digit) return { type: "skill", slot: Number(digit[1]) };
  switch (code) {
    case "Enter":
    case "NumpadEnter":
      return { type: "chat" };
    case "KeyI":
      return { type: "inventory" };
    case "KeyZ":
    case "Comma":
      return { type: "pickup" };
    case "KeyT":
      return { type: "talk" };
    case "KeyQ":
      return { type: "potion" };
    case "Escape":
      return { type: "close" };
    default:
      return null;
  }
}
