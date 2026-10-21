import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { callTool, createTask, denyAll, listTaskTitles, pendingApprovals } from './helpers';

const SHOTS = path.resolve(__dirname, '../screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => path.join(SHOTS, `${name}.png`);
const MOCK_PORT = process.env.E2E_MOCK_PORT ?? '8642';

test.describe.configure({ mode: 'serial' });

test.describe('G1 quick bar', () => {
  test('/task creates a task, /undo needs an armed Confirm, then the task is gone', async ({ page, request }) => {
    const title = `Quick ${Date.now()}`;
    await page.goto('/#/quick');
    await expect(page.getByTestId('quick-bar')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    const input = page.getByLabel('Quick command');
    await expect(input).toBeFocused();
    await page.screenshot({ path: shot('30-quick-empty') });
    await input.fill(`/task ${title}`);
    await input.press('Enter');
    await expect(page.getByTestId('cmd-done')).toContainText(title);
    expect(await listTaskTitles(request)).toContain(title);
    await page.screenshot({ path: shot('31-quick-task') });

    // it shows up in the main app
    await page.goto('/');
    await expect(page.getByTestId('task-row').filter({ hasText: title })).toBeVisible();

    await page.goto('/#/quick');
    await page.getByLabel('Quick command').fill('/undo');
    await page.getByLabel('Quick command').press('Enter');
    await expect(page.getByTestId('undo-target')).toContainText(title);
    // Enter in the input must never undo; the Confirm button only exists after the arm delay
    await page.getByLabel('Quick command').press('Enter');
    await expect(page.getByTestId('undo-confirm-cmd')).toBeVisible();
    await page.getByLabel('Quick command').press('Enter');
    await page.waitForTimeout(300);
    expect(await listTaskTitles(request)).toContain(title);
    await page.screenshot({ path: shot('32-quick-undo-armed') });
    await page.getByTestId('undo-confirm-cmd').click();
    await expect(page.getByTestId('undo-done')).toBeVisible();
    expect(await listTaskTitles(request)).not.toContain(title);
  });

  test('free text streams an /ask answer; Open in Workbench hands the question to the chat', async ({ page }) => {
    await page.goto('/#/quick');
    const input = page.getByLabel('Quick command');
    await input.fill('what is on my plate');
    await input.press('Enter');
    await expect(page.getByTestId('ask-answer')).toContainText('Mock Hermes heard');
    await expect(page.getByTestId('ask-answer')).toContainText('what is on my plate');
    await page.screenshot({ path: shot('33-quick-ask') });
    await page.getByTestId('open-in-workbench').click();
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
    // the exact thread opens with the Q&A already in it; nothing was re-sent
    await expect(page.getByTestId('msg-user')).toHaveCount(1);
    await expect(page.getByTestId('msg-user')).toContainText('what is on my plate');
    await expect(page.getByTestId('msg-assistant')).toContainText('Mock Hermes heard');
    await page.waitForTimeout(500);
    await expect(page.getByTestId('msg-user')).toHaveCount(1);
    await expect(page.getByLabel('Message Hermes')).toHaveValue('');
  });

  test('an approval arriving while the quick route is open is not decided by Enter spam', async ({ page, request }) => {
    await page.goto('/#/quick');
    const input = page.getByLabel('Quick command');
    await expect(input).toBeFocused();
    const title = `Spam guard ${Date.now()}`;
    const pending = callTool(request, 'tasks_create', { title });
    const link = page.getByTestId('quick-approvals-link');
    for (let i = 0; i < 15; i++) {
      await input.press('Enter');
      await page.waitForTimeout(40);
    }
    await expect(link).toContainText('approval');
    for (let i = 0; i < 15; i++) {
      await input.press(i % 2 ? 'Enter' : 'Meta+Enter');
      await page.waitForTimeout(40);
    }
    await page.keyboard.down('Enter');
    await page.waitForTimeout(400);
    await page.keyboard.up('Enter');
    await page.screenshot({ path: shot('34-quick-approval-waiting') });
    expect((await pendingApprovals(request)).some((a) => a.tool === 'tasks_create')).toBe(true);
    expect(await listTaskTitles(request)).not.toContain(title);
    await denyAll(request);
    await pending;
  });
});

test.describe('G1 connection doctor', () => {
  test('ok-ish with the mock up; fail + banner + fix when Hermes URL points at a dead port', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Settings/ }).click();
    const reach = page.getByTestId('doctor-check-hermes_reachable');
    await expect(reach).toHaveAttribute('data-status', 'ok');
    await expect(page.getByTestId('doctor-check-hermes_auth')).toHaveAttribute('data-status', 'ok');
    await expect(page.getByTestId('doctor-check-profile_locked')).toHaveAttribute('data-status', /ok|warn/);
    await expect(page.getByTestId('doctor-status')).toHaveCount(0);
    await page.screenshot({ path: shot('35-doctor-ok') });

    try {
      await page.getByLabel('Hermes URL').fill('http://127.0.0.1:9/v1');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(reach).toHaveAttribute('data-status', 'fail');
      await expect(page.getByTestId('doctor-fix-hermes_reachable')).toContainText('hermes -p workbench gateway run');
      await expect(page.getByTestId('doctor-summary')).toContainText('needs attention');
      // sidebar status item (stable slot above Commands): visible, clickable, opens Settings
      await expect(page.getByTestId('doctor-status')).toContainText('Connection');
      await page.screenshot({ path: shot('36-doctor-fail-banner') });
      await page.getByRole('button', { name: /Tasks/ }).click();
      await page.getByTestId('doctor-status').click();
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
      await expect(page.getByTestId('doctor-panel')).toBeVisible();
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(reach).toHaveAttribute('data-status', 'fail');
    } finally {
      await page.getByLabel('Hermes URL').fill(`http://127.0.0.1:${MOCK_PORT}/v1`);
      await page.getByRole('button', { name: 'Save' }).click();
    }
    await expect(reach).toHaveAttribute('data-status', 'ok');
    await expect(page.getByTestId('doctor-status')).toHaveCount(0);
  });

  test('/status in the quick bar reports the checks', async ({ page }) => {
    await page.goto('/#/quick');
    await page.getByLabel('Quick command').fill('/status');
    await page.getByLabel('Quick command').press('Enter');
    await expect(page.getByTestId('status-result')).toContainText('Hermes API');
  });
});

test.describe('G1 chat threads', () => {
  test('threads persist across task switches and reloads; New thread starts a second one', async ({ page, request }) => {
    const a = await createTask(request, `Thread A ${Date.now()}`);
    const b = await createTask(request, `Thread B ${Date.now()}`);
    await page.goto('/');
    const rowA = page.getByTestId('task-row').filter({ hasText: a.title });
    const rowB = page.getByTestId('task-row').filter({ hasText: b.title });
    await rowA.click();
    await expect(page.getByTestId('chat-context')).toContainText(a.title);
    await page.getByLabel('Message Hermes').fill('alpha question');
    await page.getByLabel('Message Hermes').press('Enter');
    await expect(page.getByTestId('msg-assistant').last()).toContainText('alpha question');

    await rowB.click();
    await expect(page.getByTestId('chat-context')).toContainText(b.title);
    await expect(page.getByTestId('msg-user')).toHaveCount(0);
    await rowA.click();
    await expect(page.getByTestId('msg-user')).toContainText('alpha question');

    await page.reload();
    await page.getByTestId('task-row').filter({ hasText: a.title }).click();
    await expect(page.getByTestId('msg-user')).toContainText('alpha question');
    await expect(page.getByTestId('msg-assistant').last()).toContainText('Mock Hermes heard');
    await page.screenshot({ path: shot('37-thread-restored') });

    await page.getByTestId('new-thread').click();
    await expect(page.getByTestId('msg-user')).toHaveCount(0);
    await page.getByLabel('Message Hermes').fill('beta question');
    await page.getByLabel('Message Hermes').press('Enter');
    await expect(page.getByTestId('msg-assistant').last()).toContainText('beta question');
    const sel = page.getByTestId('thread-switcher').getByRole('combobox');
    await expect(sel.locator('option')).toHaveCount(2);
    await page.screenshot({ path: shot('38-two-threads') });
    // switch back to the first thread (second option, newest first)
    await sel.selectOption({ index: 1 });
    await expect(page.getByTestId('msg-user')).toContainText('alpha question');
    await expect(page.getByTestId('msg-user')).not.toContainText('beta question');
  });
});

test.describe('G1 ledger', () => {
  test('14-day chart with zero days, tiles and the per-run table', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Ledger/ }).click();
    await expect(page.getByTestId('day-bar')).toHaveCount(14);
    await expect(page.getByTestId('tile-today')).toBeVisible();
    await expect(page.getByTestId('tile-7d')).toBeVisible();
    await expect(page.getByTestId('tile-30d')).toBeVisible();
    expect(await page.locator('rect.bar.zero').count()).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId('run-row').first()).toBeVisible();
    await page.screenshot({ path: shot('39-ledger-chart') });
  });
});

test.describe('G1 notification re-activation (P0 regression)', () => {
  test('draft in the composer, notification, re-activation, then typing + ⌘↵ never decides and keeps focus', async ({ page, request }) => {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__bg = false;
      w.__notified = [];
      document.hasFocus = () => !w.__bg;
      w.__WORKBENCH_NATIVE__ = {
        notify: (title: string, body: string, id: string) => (w.__notified as unknown[]).push({ title, body, id }),
        setBadge: () => undefined,
      };
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
    const composer = page.getByLabel('Message Hermes');
    await composer.click();
    await page.keyboard.type('my draft');
    await page.evaluate(() => ((window as unknown as { __bg: boolean }).__bg = true)); // app in background

    const title = `Reactivate ${Date.now()}`;
    const pending = callTool(request, 'tasks_create', { title });
    await expect(page.getByTestId('approval-card')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __notified: unknown[] }).__notified.length)).toBe(1);
    await page.waitForTimeout(900); // past every guard: only focus behaviour is under test

    // user comes back: WebKit restores focus to the composer, then the app sees activation
    await page.evaluate(() => {
      (window as unknown as { __bg: boolean }).__bg = false;
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('html')).toHaveAttribute('data-approval-pulse', ''); // visible highlight only
    await page.screenshot({ path: shot('40-reactivation-pulse') });
    await expect(composer).toBeFocused();

    await page.keyboard.type(' and more');
    await page.keyboard.press('Meta+Enter');
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(800);
    expect((await pendingApprovals(request)).some((a) => a.tool === 'tasks_create')).toBe(true);
    expect(await listTaskTitles(request)).not.toContain(title);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue('my draft and more');
    await denyAll(request);
    await pending;
  });

  test('an automatic (non-explicit) focus-approval event never moves focus; an explicit one does, with the guard re-armed', async ({ page, request }) => {
    await page.goto('/');
    const composer = page.getByLabel('Message Hermes');
    await composer.click();
    const pending = callTool(request, 'tasks_create', { title: `Explicit ${Date.now()}` });
    const card = page.getByTestId('approval-card');
    await expect(card).toBeVisible();
    await page.waitForTimeout(900);
    await page.evaluate(() => window.dispatchEvent(new Event('workbench:focus-approval')));
    await page.waitForTimeout(100);
    await expect(composer).toBeFocused();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('workbench:focus-approval', { detail: { explicit: true } })));
    await expect(card).toBeFocused();
    await page.keyboard.press('Meta+Enter'); // immediately after the programmatic focus move: inert
    await page.waitForTimeout(300);
    expect((await pendingApprovals(request)).length).toBeGreaterThan(0);
    await denyAll(request);
    await pending;
  });
});
