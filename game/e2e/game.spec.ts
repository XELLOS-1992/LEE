// 실제 브라우저(Chromium)로 게임을 플레이하는 E2E 테스트
import { expect, test, type Page } from "@playwright/test";

interface GameHandle {
  state: {
    me: { id: number; name: string } | null;
    self: { gold: number; inventory: ({ item: string; qty: number } | null)[]; stats: { hp: number } } | null;
    snapshot: {
      map: string;
      players: { id: number; x: number; y: number; dir: string }[];
      monsters: { id: number; kind: string; x: number; y: number; hp: number; maxHp: number }[];
    } | null;
    chat: { from: string; text: string }[];
    sent: Record<string, number>;
  };
  renderStats: {
    frames: number; tiles: number; players: number; monsters: number; npcs: number; nameplates: number; hpBars: number;
    hud: boolean; chatBox: boolean; camera: { x: number; y: number }; meScreen: { x: number; y: number };
    view: { w: number; h: number; zoom: number };
  };
  send: (m: unknown) => void;
}
declare global {
  interface Window { __game: GameHandle }
}

const uniq = () => String(Date.now() % 100000).padStart(5, "0") + Math.floor(Math.random() * 9);

async function enter(page: Page, name: string, job = "warrior") {
  await page.goto("/");
  await expect(page.locator("canvas#game")).toBeVisible();
  await page.fill("#name", name);
  await page.selectOption("#job", job);
  await page.click("#start");
  await page.waitForFunction(() => !!window.__game?.state.me && !!window.__game.state.snapshot && !!window.__game.state.self);
  await expect(page.locator("#login")).toBeHidden();
}

async function me(page: Page) {
  return page.evaluate(() => {
    const g = window.__game;
    return g.state.snapshot!.players.find((p) => p.id === g.state.me!.id)!;
  });
}

async function step(page: Page, key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight", times = 1) {
  for (let i = 0; i < times; i++) {
    const before = await me(page);
    await page.keyboard.press(key);
    await page.waitForFunction(
      ([x, y]) => {
        const g = window.__game;
        const p = g.state.snapshot!.players.find((q) => q.id === g.state.me!.id)!;
        return p.x !== x || p.y !== y;
      },
      [before.x, before.y],
    );
    await page.waitForTimeout(220);
  }
}

test("AC-19 브라우저로 접속→이동→채팅→공격, 캔버스 픽셀 확인, 스크린샷 저장", async ({ page }) => {
  await enter(page, `용사${uniq()}`);
  const start = await me(page);

  // 이동
  await step(page, "ArrowUp");
  const moved = await me(page);
  expect([moved.x, moved.y]).toEqual([start.x, start.y - 1]);

  // 채팅
  await page.keyboard.press("Enter");
  await expect(page.locator("#chat-input")).toBeFocused();
  await page.keyboard.type("안녕하세요 풍운록");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__game.state.chat.some((c) => c.text === "안녕하세요 풍운록"));

  // 공격: 바라보는 칸에 다람쥐를 소환(테스트 전용 훅)한 뒤 Space 로 때린다
  await page.evaluate(() => window.__game.send({ t: "debug", cmd: "spawn", kind: "squirrel" }));
  await page.waitForFunction(() => window.__game.state.snapshot!.monsters.length > 0);
  await page.waitForFunction(() => window.__game.renderStats.monsters > 0);
  const monId = await page.evaluate(() => window.__game.state.snapshot!.monsters[0].id);
  let damaged = false;
  for (let i = 0; i < 12 && !damaged; i++) {
    await page.keyboard.press("Space");
    await page.waitForTimeout(400);
    damaged = await page.evaluate((id) => {
      const m = window.__game.state.snapshot!.monsters.find((x) => x.id === id);
      return !m || m.hp < m.maxHp;
    }, monId);
  }
  expect(damaged).toBe(true);
  expect(await page.evaluate(() => window.__game.state.sent.attack)).toBeGreaterThan(0);

  // 캔버스가 비어 있지 않은지 픽셀로 확인
  const pixels = await page.evaluate(() => {
    const c = document.getElementById("game") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const colors = new Set<number>();
    let nonBlack = 0, total = 0;
    for (let i = 0; i < d.length; i += 4 * 7) {
      total++;
      if (d[i] + d[i + 1] + d[i + 2] > 30) nonBlack++;
      colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
    return { distinct: colors.size, nonBlackRatio: nonBlack / total };
  });
  expect(pixels.distinct).toBeGreaterThan(50);
  expect(pixels.nonBlackRatio).toBeGreaterThan(0.8);
  await page.screenshot({ path: "test-results/screens/ac19-gameplay.png" });
});

test("AC-15 캔버스에 맵·캐릭터·이름표·HP바·채팅창·상태창을 그리고 카메라가 플레이어를 따라간다", async ({ page }) => {
  await enter(page, `화가${uniq()}`, "mage");
  await page.waitForFunction(() => window.__game.renderStats.frames > 5);
  const r = await page.evaluate(() => window.__game.renderStats);
  expect(r.tiles).toBeGreaterThan(0);
  expect(r.players).toBeGreaterThanOrEqual(1);
  expect(r.npcs).toBeGreaterThanOrEqual(3);
  expect(r.nameplates).toBeGreaterThanOrEqual(4);
  expect(r.hpBars).toBeGreaterThanOrEqual(1);
  expect(r.hud).toBe(true);
  expect(r.chatBox).toBe(true);
  // 플레이어는 화면 중앙 근처
  expect(Math.abs(r.meScreen.x + 16 - r.view.w / 2)).toBeLessThanOrEqual(16);
  expect(Math.abs(r.meScreen.y + 16 - r.view.h / 2)).toBeLessThanOrEqual(16);
  const cam0 = r.camera;
  await step(page, "ArrowRight");
  await page.waitForTimeout(300);
  const cam1 = await page.evaluate(() => window.__game.renderStats.camera);
  expect(cam1.x - cam0.x).toBe(32);
  expect(cam1.y).toBe(cam0.y);
  await page.screenshot({ path: "test-results/screens/ac15-town.png" });
});

test("AC-15 게임 화면은 브라우저 창 전체를 채우고, 창을 키우면 함께 커진다", async ({ page }) => {
  await enter(page, `큰창${uniq()}`);
  const size = () =>
    page.evaluate(() => {
      const r = document.getElementById("game")!.getBoundingClientRect();
      return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, view: window.__game.renderStats.view };
    });
  const small = await size();
  expect(small.w).toBe(small.vw);
  expect(small.h).toBe(small.vh);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(200);
  const big = await size();
  expect([big.w, big.h]).toEqual([1600, 1000]);
  expect(big.view.zoom).toBeGreaterThan(small.view.zoom);
  // 확대 후에도 가로 26칸·세로 16칸 이상이 보인다
  expect(big.view.w).toBeGreaterThanOrEqual(26 * 32);
  expect(big.view.h).toBeGreaterThanOrEqual(16 * 32);
  await page.waitForFunction(() => window.__game.renderStats.frames > 3);
  await page.screenshot({ path: "test-results/screens/ac15-large.png" });
});

test("AC-16 키보드 입력: 방향키·Space·숫자키·Enter·I·Esc", async ({ page }) => {
  await enter(page, `손님${uniq()}`, "poet");
  await page.keyboard.press("KeyI");
  await expect(page.locator("#inventory")).toBeVisible();
  await expect(page.locator("#inv-grid .slot")).toHaveCount(20);
  await page.keyboard.press("Escape");
  await expect(page.locator("#inventory")).toBeHidden();
  await page.keyboard.press("Space");
  await page.keyboard.press("Digit1");
  await page.waitForFunction(() => (window.__game.state.sent.attack ?? 0) > 0 && (window.__game.state.sent.skill ?? 0) > 0);
  await page.keyboard.press("Enter");
  await expect(page.locator("#chat-input")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#chat-input")).toBeHidden();
  await step(page, "ArrowLeft");
  await step(page, "ArrowDown");
});

test("AC-13 주모에게 말을 걸어 물약을 산다 (UI)", async ({ page }) => {
  await enter(page, `손님${uniq()}`);
  // 입구(24,26)에서 주모(20,20) 바로 아래 (20,21)까지 이동
  await step(page, "ArrowLeft", 4);
  await step(page, "ArrowUp", 5);
  const p = await me(page);
  expect([p.x, p.y]).toEqual([20, 21]);
  await page.keyboard.press("KeyT");
  await expect(page.locator("#dialog")).toBeVisible();
  await expect(page.locator("#dialog h3")).toHaveText("주모");
  const gold0 = await page.evaluate(() => window.__game.state.self!.gold);
  await page.click('#dialog button[data-item="potion_blue"]');
  await page.waitForFunction((g) => window.__game.state.self!.gold < g, gold0);
  const inv = await page.evaluate(() => window.__game.state.self!.inventory);
  expect(inv.some((s) => s?.item === "potion_blue")).toBe(true);
  await page.screenshot({ path: "test-results/screens/ac13-shop.png" });
});
