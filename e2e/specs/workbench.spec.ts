import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { callTool, toolText } from './helpers';

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

test('keyboard: ⌘↵ approves the card', async ({ page, request }) => {
  await page.goto('/');
  const title = `Keyboard ${Date.now()}`;
  const pending = callTool(request, 'tasks_create', { title });
  await expect(page.getByTestId('approval-card')).toBeVisible();
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
