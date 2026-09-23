import { describe, expect, it } from "vitest";
import { approach, computeCamera } from "../client/camera";
import { keyToAction } from "../client/input";

describe("AC-15 클라이언트 카메라", () => {
  const T = 32, W = 960, H = 640, MAP = 48 * 32;

  it("AC-15 카메라는 플레이어를 화면 중앙에 둔다", () => {
    const c = computeCamera(24 * T, 24 * T, MAP, MAP, W, H, T);
    expect(24 * T - c.x + T / 2).toBe(W / 2);
    expect(24 * T - c.y + T / 2).toBe(H / 2);
  });

  it("AC-15 맵 가장자리에서는 맵 밖이 보이지 않게 고정된다", () => {
    expect(computeCamera(0, 0, MAP, MAP, W, H, T)).toEqual({ x: 0, y: 0 });
    expect(computeCamera(47 * T, 47 * T, MAP, MAP, W, H, T)).toEqual({ x: MAP - W, y: MAP - H });
  });

  it("AC-15 플레이어가 움직이면 카메라가 따라간다", () => {
    const a = computeCamera(20 * T, 20 * T, MAP, MAP, W, H, T);
    const b = computeCamera(21 * T, 22 * T, MAP, MAP, W, H, T);
    expect(b.x - a.x).toBe(T);
    expect(b.y - a.y).toBe(2 * T);
  });

  it("AC-15 이동 보간: 일정 속도로 다가가고 멀리 떨어지면 즉시 이동", () => {
    expect(approach(0, 32, 8, 96)).toBe(8);
    expect(approach(28, 32, 8, 96)).toBe(32);
    expect(approach(0, -32, 8, 96)).toBe(-8);
    expect(approach(0, 500, 8, 96)).toBe(500);
  });
});

describe("AC-16 입력", () => {
  it("AC-16 방향키는 이동", () => {
    expect(keyToAction("ArrowUp")).toEqual({ type: "move", dir: "up" });
    expect(keyToAction("ArrowDown")).toEqual({ type: "move", dir: "down" });
    expect(keyToAction("ArrowLeft")).toEqual({ type: "move", dir: "left" });
    expect(keyToAction("ArrowRight")).toEqual({ type: "move", dir: "right" });
  });

  it("AC-16 Space/Ctrl 공격, 숫자키 스킬, Enter 채팅, I 인벤토리", () => {
    expect(keyToAction("Space")).toEqual({ type: "attack" });
    expect(keyToAction("ControlLeft")).toEqual({ type: "attack" });
    expect(keyToAction("ControlRight")).toEqual({ type: "attack" });
    expect(keyToAction("Digit1")).toEqual({ type: "skill", slot: 1 });
    expect(keyToAction("Digit2")).toEqual({ type: "skill", slot: 2 });
    expect(keyToAction("Numpad3")).toEqual({ type: "skill", slot: 3 });
    expect(keyToAction("Digit0")).toBeNull();
    expect(keyToAction("Enter")).toEqual({ type: "chat" });
    expect(keyToAction("KeyI")).toEqual({ type: "inventory" });
    expect(keyToAction("KeyZ")).toEqual({ type: "pickup" });
    expect(keyToAction("KeyT")).toEqual({ type: "talk" });
    expect(keyToAction("KeyQ")).toEqual({ type: "potion" });
    expect(keyToAction("Escape")).toEqual({ type: "close" });
    expect(keyToAction("KeyP")).toBeNull();
  });
});
