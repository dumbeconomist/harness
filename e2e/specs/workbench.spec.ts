import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { callTool, callToolAbortable, createTask, denyAll, listTaskTitles, pendingApprovals, toolText } from './helpers';

const SHOTS = path.resolve(__dirname, '../screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => path.join(SHOTS, `${name}.png`);

test.describe.configure({ mode: 'serial' });

test('empty states render and app loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  await expect(page.getByLabel('New task')).toBeVisible();
  await page.screenshot({ path: shot('01-tasks-initial') });
});

test('approval flow: MCP tasks_create blocks, card appears, Approve creates the task', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();

  const title = `Buy milk ${Date.now()}`;
  const pending = callTool(request, 'tasks_create', { title }); // deliberately not awaited yet

  const card = page.getByTestId('approval-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('tasks_create');
  await expect(card).toContainText(title);
  await expect(page.getByTestId('tier-badge')).toContainText('Tier 1');
  await expect(page.getByTestId('approvals-badge')).toHaveText('1');
  await page.waitForTimeout(400); // let the slide-in animation settle
  await page.screenshot({ path: shot('02-approval-card') });

  await card.getByTestId('approve-btn').click();
  await expect(card).toBeHidden();
  await expect(page.getByTestId('task-row').filter({ hasText: title })).toBeVisible();

  const res = await pending;
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.result?.isError).toBeFalsy();
  expect(toolText(body)).toContain(title);
  await page.screenshot({ path: shot('03-task-created') });
});

test('keyboard: ⌘↵ approves only when focus is inside the card', async ({ page, request }) => {
  await page.goto('/');
  const title = `Keyboard ${Date.now()}`;
  const pending = callTool(request, 'tasks_create', { title });
  const card = page.getByTestId('approval-card');
  await expect(card).toBeVisible();
  await page.waitForTimeout(800); // past the mount guard
  await page.keyboard.press('Meta+Enter'); // focus is NOT in the card
  await page.waitForTimeout(300);
  expect((await pendingApprovals(request)).length).toBeGreaterThan(0);
  await card.getByLabel('Note (optional)').click();
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('task-row').filter({ hasText: title })).toBeVisible();
  expect(toolText(await (await pending).json())).toContain(title);
});

test('deny flow: Deny returns an MCP error and creates nothing', async ({ page, request }) => {
  await page.goto('/');
  const title = `Denied ${Date.now()}`;
  const pending = callTool(request, 'tasks_create', { title });

  const card = page.getByTestId('approval-card');
  await expect(card).toBeVisible();
  await card.getByLabel('Note (optional)').fill('not today');
  await card.getByTestId('deny-btn').click();
  await expect(card).toBeHidden();

  const body = await (await pending).json();
  expect(body.result?.isError).toBe(true);
  expect(toolText(body)).toMatch(/Denied by user/);
  expect(toolText(body)).toContain('not today');
  await expect(page.getByTestId('task-row').filter({ hasText: title })).toHaveCount(0);
  await page.screenshot({ path: shot('04-denied') });
});

test('undo flow: quick-add a task, undo it from Activity', async ({ page }) => {
  await page.goto('/');
  const title = `Undo me ${Date.now()}`;
  await page.getByLabel('New task').fill(title);
  await page.getByLabel('New task').press('Enter');
  const row = page.getByTestId('task-row').filter({ hasText: title });
  await expect(row).toBeVisible();

  await page.getByRole('button', { name: /Activity/ }).click();
  const entry = page.getByTestId('journal-entry').filter({ hasText: title }).first();
  await expect(entry).toBeVisible();
  await page.screenshot({ path: shot('05-activity') });
  await entry.getByTestId('undo-btn').click();
  await entry.getByTestId('undo-confirm').click();
  await expect(entry.getByRole('button', { name: 'Undone' })).toBeDisabled();

  await page.getByRole('button', { name: /Tasks/ }).click();
  await expect(page.getByTestId('task-row').filter({ hasText: title })).toHaveCount(0);
});

test('chat streams a reply from Hermes (mock) in task context', async ({ page }) => {
  await page.goto('/');
  const title = `Chat target ${Date.now()}`;
  await page.getByLabel('New task').fill(title);
  await page.getByLabel('New task').press('Enter');
  await page.getByTestId('task-row').filter({ hasText: title }).click();
  await expect(page.getByTestId('chat-context')).toContainText(title);

  await page.getByLabel('Message Hermes').fill('hello there');
  await page.getByLabel('Message Hermes').press('Enter');
  await expect(page.getByTestId('msg-user')).toContainText('hello there');
  await expect(page.getByTestId('msg-assistant').last()).toContainText('Mock Hermes heard');
  await expect(page.getByTestId('msg-assistant').last()).toContainText('hello there');
  await page.screenshot({ path: shot('06-chat') });
});

test('ledger shows spend after chat; settings tier-2 locked; palette opens', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Ledger/ }).click();
  await expect(page.getByTestId('ledger-total')).toBeVisible();
  await page.screenshot({ path: shot('07-ledger') });

  await page.getByRole('button', { name: /Settings/ }).click();
  await expect(page.getByLabel(/tasks_delete/)).toBeDisabled();
  await expect(page.getByTestId('hermes-status')).toContainText('Hermes is reachable');
  await page.screenshot({ path: shot('08-settings') });

  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Command', exact: true }).fill('ledger');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Ledger' })).toBeVisible();
});

test.describe('approval card safety regressions (P0)', () => {
  /** A tier-2 delete request for a task we create; returns the in-flight MCP promise. */
  async function armDelete(request: Parameters<typeof callTool>[0]) {
    const title = `Precious ${Date.now()}`;
    const task = await createTask(request, title);
    return { title, task, pending: callTool(request, 'tasks_delete', { id: task.id }) };
  }
  async function assertStillPending(request: Parameters<typeof callTool>[0], title: string) {
    await new Promise((r) => setTimeout(r, 500));
    expect((await pendingApprovals(request)).some((a) => a.tool === 'tasks_delete')).toBe(true);
    expect(await listTaskTitles(request)).toContain(title);
  }
  async function cleanup(page: import('@playwright/test').Page, pending: ReturnType<typeof callTool>) {
    // deny through the UI so the blocked MCP call completes
    await page.getByTestId('deny-btn').click();
    await pending;
  }

  test('(a) typing continuously in the chat composer while a tier-2 card appears does not decide it', async ({ page, request }) => {
    await page.goto('/');
    const composer = page.getByLabel('Message Hermes');
    await composer.click();
    const text = 'what should I do next with all of these tasks and things';
    const typing = composer.pressSequentially(text, { delay: 40 });
    await page.waitForTimeout(400);
    const { title, pending } = await armDelete(request);
    await typing;
    await expect(page.getByTestId('approval-card')).toBeVisible();
    await expect(composer).toHaveValue(text);
    await assertStillPending(request, title);
    await page.screenshot({ path: shot('09-tier2-card') });
    await cleanup(page, pending);
  });

  test('(b) Ctrl+Enter and ⌘+Enter in the composer do not approve', async ({ page, request }) => {
    await page.goto('/');
    const { title, pending } = await armDelete(request);
    await expect(page.getByTestId('approval-card')).toBeVisible();
    await page.waitForTimeout(800);
    const composer = page.getByLabel('Message Hermes');
    await composer.click();
    await composer.pressSequentially('hello');
    await page.keyboard.press('Control+Enter');
    await page.keyboard.press('Meta+Enter');
    await assertStillPending(request, title);
    await expect(composer).toHaveValue('hello');
    await cleanup(page, pending);
  });

  test('(c) Esc in quick-add does not deny (and Esc in the card only collapses it)', async ({ page, request }) => {
    await page.goto('/');
    const { title, pending } = await armDelete(request);
    await expect(page.getByTestId('approval-card')).toBeVisible();
    await page.waitForTimeout(800);
    await page.getByLabel('New task').click();
    await page.keyboard.press('Escape');
    await assertStillPending(request, title);
    await expect(page.getByTestId('approval-card')).toBeVisible();
    await page.getByTestId('approval-card').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('approval-badge')).toBeVisible();
    await page.screenshot({ path: shot('10-card-collapsed') });
    await assertStillPending(request, title);
    await page.getByTestId('approval-badge').click();
    await cleanup(page, pending);
  });

  test('(d) holding Enter does not approve', async ({ page, request }) => {
    await page.goto('/');
    const { title, pending } = await armDelete(request);
    await expect(page.getByTestId('approval-card')).toBeVisible();
    await page.getByLabel('Message Hermes').click();
    for (let i = 0; i < 15; i++) {
      await page.keyboard.down('Enter');
      await page.waitForTimeout(40);
    }
    await page.keyboard.up('Enter');
    await assertStillPending(request, title);
    await cleanup(page, pending);
  });

  test('tier 2 requires Review, then an explicit click deletes the task', async ({ page, request }) => {
    await page.goto('/');
    const { title, pending } = await armDelete(request);
    const card = page.getByTestId('approval-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('approve-btn')).toHaveCount(0);
    await expect(card.getByTestId('tier-badge')).toContainText('Tier 2');
    await page.waitForTimeout(800);
    await card.getByTestId('review-btn').click();
    await expect(card.getByTestId('ac-target')).toContainText(title);
    await page.screenshot({ path: shot('11-tier2-reviewed') });
    await card.getByTestId('approve-btn').click();
    const body = await (await pending).json();
    expect(body.result?.isError).toBeFalsy();
    await expect.poll(() => listTaskTitles(request)).not.toContain(title);
  });
});

test('real loop: chat "add a task to buy milk" → tool chip → card → approve → reply → task → undo', async ({ page, request }) => {
  await page.goto('/');
  const milk = `buy milk ${Date.now()}`;
  const composer = page.getByLabel('Message Hermes');
  await composer.fill(`add a task to ${milk}`);
  await composer.press('Enter');

  await expect(page.getByTestId('tool-chip').first()).toContainText('tasks_create');
  const card = page.getByTestId('approval-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText(milk);
  await page.waitForTimeout(800);
  await page.screenshot({ path: shot('12-loop-card') });
  await card.getByTestId('approve-btn').click();

  await expect(page.getByTestId('msg-assistant').last()).toContainText(`Added task: ${milk}`);
  await expect(page.getByTestId('task-row').filter({ hasText: milk })).toBeVisible();
  await page.screenshot({ path: shot('13-loop-done') });

  await page.getByRole('button', { name: /Activity/ }).click();
  const entry = page.getByTestId('journal-entry').filter({ hasText: milk }).first();
  await entry.getByTestId('undo-btn').click();
  await entry.getByTestId('undo-confirm').click();
  await expect(entry.getByRole('button', { name: 'Undone' })).toBeDisabled();
  await page.getByRole('button', { name: /Tasks/ }).click();
  await expect(page.getByTestId('task-row').filter({ hasText: milk })).toHaveCount(0);
});

test('task detail: agent-visible notes can be edited; delete needs confirm', async ({ page, request }) => {
  const t = await createTask(request, `Detail ${Date.now()}`);
  await page.goto('/');
  await page.getByTestId('task-row').filter({ hasText: t.title }).click();
  const detail = page.getByTestId('task-detail');
  await detail.getByLabel('Task notes').fill('remember the oat milk');
  await detail.getByLabel('Task title').click(); // blur notes → save
  await expect.poll(async () => (await (await request.get(`http://127.0.0.1:${process.env.E2E_CORE_PORT ?? '8765'}/api/tasks`, { headers: { Authorization: 'Bearer e2e-token' } })).json()).find((x: { id: string }) => x.id === t.id)?.notes).toBe('remember the oat milk');
  await page.screenshot({ path: shot('14-task-detail') });
  await detail.getByTestId('td-delete').click();
  await detail.getByTestId('td-delete-confirm').click();
  await expect(page.getByTestId('task-row').filter({ hasText: t.title })).toHaveCount(0);
});

test('settings: Hermes form, connection reveal, disabled permissions', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Settings/ }).click();
  await expect(page.getByLabel('Hermes URL')).toBeVisible();
  await expect(page.getByTestId('mcp-snippet')).toHaveCount(0);
  await page.getByRole('button', { name: /Reveal snippet/ }).click();
  await expect(page.getByTestId('mcp-snippet')).toContainText('e2e-mcp-token');
  await expect(page.getByRole('switch', { name: /Web access/ })).toBeDisabled();
  await page.screenshot({ path: shot('15-settings-hermes') });
});

test.describe('round-3 regressions: Review→Approve focus, list double-click, palette', () => {
  async function arm(request: Parameters<typeof callTool>[0]) {
    const title = `Precious ${Date.now()}`;
    const task = await createTask(request, title);
    return { title, task, pending: callTool(request, 'tasks_delete', { id: task.id }) };
  }
  async function stillPending(request: Parameters<typeof callTool>[0], title: string) {
    await new Promise((r) => setTimeout(r, 900)); // longer than the 600ms re-arm
    expect((await pendingApprovals(request)).some((a) => a.tool === 'tasks_delete')).toBe(true);
    expect(await listTaskTitles(request)).toContain(title);
  }

  test('focus Review, Enter, Enter does not approve', async ({ page, request }) => {
    await page.goto('/');
    const { title, pending } = await arm(request);
    const card = page.getByTestId('approval-card');
    await expect(card).toBeVisible();
    await page.waitForTimeout(800);
    await card.getByTestId('review-btn').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await stillPending(request, title);
    await denyAll(request);
    await pending;
  });

  test('hold Enter on focused Review does not approve', async ({ page, request }) => {
    await page.goto('/');
    const { title, pending } = await arm(request);
    const card = page.getByTestId('approval-card');
    await expect(card).toBeVisible();
    await page.waitForTimeout(800);
    await card.getByTestId('review-btn').focus();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.down('Enter');
      await page.waitForTimeout(30);
    }
    await page.keyboard.up('Enter');
    await stillPending(request, title);
    await denyAll(request);
    await pending;
  });

  test('mouse-click Review then Space does not approve', async ({ page, request }) => {
    await page.goto('/');
    const { title, pending } = await arm(request);
    const card = page.getByTestId('approval-card');
    await expect(card).toBeVisible();
    await page.waitForTimeout(800);
    await card.getByTestId('review-btn').click();
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await stillPending(request, title);
    await page.screenshot({ path: shot('16-review-rearmed') });
    await denyAll(request);
    await pending;
  });

  test('Approvals list: tier-2 Review, Enter, Enter does not approve', async ({ page, request }) => {
    await page.goto('/');
    const { title, pending } = await arm(request);
    await expect(page.getByTestId('approval-card')).toBeVisible();
    await page.getByRole('button', { name: /Approvals/ }).click();
    await page.waitForTimeout(800);
    await page.getByTestId('row-review').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await stillPending(request, title);
    await denyAll(request);
    await pending;
  });

  test('Approvals list: double-click on row 1 does not approve row 2', async ({ page, request }) => {
    await page.goto('/');
    const a = await createTask(request, `Victim A ${Date.now()}`);
    const b = await createTask(request, `Victim B ${Date.now()}`);
    const p1 = callTool(request, 'tasks_update', { id: a.id, title: `${a.title} (renamed)` });
    await expect.poll(async () => (await pendingApprovals(request)).length).toBe(1);
    const p2 = callTool(request, 'tasks_update', { id: b.id, title: `${b.title} (renamed)` });
    await expect.poll(async () => (await pendingApprovals(request)).length).toBe(2);
    await page.getByRole('button', { name: /Approvals/ }).click();
    await expect(page.getByTestId('approval-row')).toHaveCount(2);
    await page.waitForTimeout(800);
    await page.screenshot({ path: shot('17-approvals-list') });
    await page.getByTestId('row-approve').first().dblclick();
    await page.waitForTimeout(900);
    expect((await pendingApprovals(request)).length).toBe(1);
    await denyAll(request);
    await Promise.all([p1, p2]);
  });

  test('palette has no approve/deny actions, only Review pending approval', async ({ page, request }) => {
    await page.goto('/');
    const { pending } = await arm(request);
    await expect(page.getByTestId('approval-card')).toBeVisible();
    await page.keyboard.press('Control+k');
    const box = page.getByRole('textbox', { name: 'Command', exact: true });
    await box.fill('approve');
    await expect(page.getByRole('option', { name: /Review pending approval/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /^Approve/ })).toHaveCount(0);
    await box.fill('deny');
    await expect(page.getByRole('option', { name: /^Deny/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await denyAll(request);
    await pending;
  });
});

test.describe('round-4 regressions: same-spot click cadences, list shifts', () => {
  type Req = Parameters<typeof callTool>[0];
  type Pg = import('@playwright/test').Page;

  const center = async (loc: import('@playwright/test').Locator) => {
    const b = (await loc.boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  async function closeChat(page: Pg) {
    await page.getByRole('button', { name: 'Hide Hermes pane' }).click();
  }

  for (const layout of ['docked', 'floating'] as const) {
    test(`queue tier-1 A then tier-2 B: clicking one spot at 0/+300/+1000ms never deletes B (${layout})`, async ({ page, request }) => {
      await page.goto('/');
      if (layout === 'floating') await closeChat(page);
      const a = await createTask(request, `Queue A ${Date.now()}`);
      const b = await createTask(request, `Queue B ${Date.now()}`);
      const pA = callTool(request, 'tasks_update', { id: a.id, title: `${a.title} v2` });
      await expect.poll(async () => (await pendingApprovals(request)).length).toBe(1);
      const pB = callTool(request, 'tasks_delete', { id: b.id });
      await expect(page.getByTestId('approval-card').getByTestId('approve-btn')).toBeEnabled();
      await page.waitForTimeout(800);
      const spot = await center(page.getByTestId('approve-btn'));
      await page.mouse.click(spot.x, spot.y); // t=0: approves A (intended)
      await page.waitForTimeout(300);
      await page.mouse.click(spot.x, spot.y);
      await page.waitForTimeout(700);
      await page.mouse.click(spot.x, spot.y); // +1000ms
      await page.waitForTimeout(1200);
      await page.mouse.click(spot.x, spot.y);
      await page.waitForTimeout(500);
      expect(await listTaskTitles(request)).toContain(b.title);
      await page.screenshot({ path: shot(`18-queue-cadence-${layout}`) });
      await denyAll(request);
      await Promise.all([pA, pB]);
      expect(await listTaskTitles(request)).toContain(b.title);
    });

    test(`single tier-2 card: Review then same-spot clicks at +650/+700/+1200ms never delete (${layout})`, async ({ page, request }) => {
      await page.goto('/');
      if (layout === 'floating') await closeChat(page);
      const t = await createTask(request, `Solo ${Date.now()}`);
      const pending = callTool(request, 'tasks_delete', { id: t.id });
      const card = page.getByTestId('approval-card');
      await expect(card).toBeVisible();
      await expect(card.getByTestId('review-btn')).toBeEnabled();
      const spot = await center(card.getByTestId('review-btn'));
      await page.mouse.click(spot.x, spot.y);
      await expect(card.getByTestId('approve-btn')).toBeVisible();
      const approve = await center(card.getByTestId('approve-btn'));
      expect(Math.abs(approve.y - spot.y)).toBeGreaterThan(30); // Approve never sits under the old Review spot
      await page.waitForTimeout(650);
      await page.mouse.click(spot.x, spot.y);
      await page.waitForTimeout(50);
      await page.mouse.click(spot.x, spot.y);
      await page.waitForTimeout(500);
      await page.mouse.click(spot.x, spot.y);
      await page.waitForTimeout(500);
      expect(await listTaskTitles(request)).toContain(t.title);
      expect((await pendingApprovals(request)).length).toBe(1);
      await page.screenshot({ path: shot(`19-review-spot-${layout}`) });
      await denyAll(request);
      await pending;
    });
  }

  test('Approvals list: expiring R0 just before clicking R1 never approves R2', async ({ page, request }) => {
    await page.goto('/');
    const ts = [] as { id: string; title: string }[];
    for (let i = 0; i < 3; i++) ts.push(await createTask(request, `Row ${i} ${Date.now()}`));
    const calls: ReturnType<typeof callToolAbortable>[] = [];
    for (let i = 0; i < 3; i++) {
      calls.push(callToolAbortable('tasks_update', { id: ts[i]!.id, title: `${ts[i]!.title} v2` }));
      await expect.poll(async () => (await pendingApprovals(request)).length).toBe(i + 1);
    }
    await page.getByRole('button', { name: /Approvals/ }).click();
    await expect(page.getByTestId('approval-row')).toHaveCount(3);
    await page.waitForTimeout(900);
    const spot = await center(page.getByTestId('row-approve').nth(1));
    calls[0]!.abort(); // requester disconnects → R0 expires and the list shifts up
    await page.waitForTimeout(100);
    await page.mouse.click(spot.x, spot.y);
    await page.waitForTimeout(900);
    const titles = await listTaskTitles(request);
    expect(titles).not.toContain(`${ts[2]!.title} v2`); // R2 untouched
    expect((await pendingApprovals(request)).length).toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: shot('20-list-shift') });
    await denyAll(request);
    await Promise.all(calls.map((c) => c.promise));
  });
});
