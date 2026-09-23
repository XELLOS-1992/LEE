// 카메라: 플레이어를 화면 중앙에 두되 맵 가장자리 밖은 보이지 않게 고정한다 (순수 함수).
export interface Camera {
  x: number;
  y: number;
}

export function computeCamera(
  targetPx: number,
  targetPy: number,
  mapWidthPx: number,
  mapHeightPx: number,
  viewW: number,
  viewH: number,
  tile: number,
): Camera {
  const clamp = (v: number, max: number) => (max <= 0 ? max / 2 : Math.max(0, Math.min(v, max)));
  return {
    x: Math.round(clamp(targetPx + tile / 2 - viewW / 2, mapWidthPx - viewW)),
    y: Math.round(clamp(targetPy + tile / 2 - viewH / 2, mapHeightPx - viewH)),
  };
}

/** 이전 표시 위치에서 목표 위치로 일정 속도로 다가간다. 멀리 떨어지면(순간이동) 즉시 이동. */
export function approach(current: number, target: number, maxStep: number, snapDistance: number): number {
  const d = target - current;
  if (Math.abs(d) > snapDistance) return target;
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}
