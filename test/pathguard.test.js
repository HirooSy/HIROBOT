import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveGuarded, checkDestructive } from '../lib/package/ai/pathguard.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pathguard-'));
const root = path.join(base, 'proj');
const outside = path.join(base, 'outside');
fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'x');
fs.symlinkSync(outside, path.join(root, 'linkdir'));
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'linkfile'));
fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'inlink'));

const inside = (p, o) => resolveGuarded(p, root, o).inside;

test('relative paths inside the project', () => {
    assert.equal(inside('sub/a.txt'), true);
    assert.equal(inside('new/dir/file.txt'), true);
    assert.equal(inside('.'), true);
});

test('traversal and absolute paths outside', () => {
    assert.equal(inside('../outside/secret.txt'), false);
    assert.equal(inside(path.join(outside, 'secret.txt')), false);
    assert.equal(inside('/etc/hosts'), false);
    assert.equal(inside('../proj-sibling'), false);
});

test('symlinked directory escapes are detected', () => {
    assert.equal(inside('linkdir/secret.txt'), false);
    assert.equal(inside('linkdir/not-yet-created.txt'), false);
    assert.equal(inside('linkdir/new/deep/file.txt'), false);
});

test('symlinked file: followed by default, link itself inside with noFollowLast', () => {
    assert.equal(inside('linkfile'), false);
    assert.equal(inside('linkfile', { noFollowLast: true }), true);
});

test('symlink that stays inside is allowed', () => {
    assert.equal(inside('inlink/a.txt'), true);
});

test('checkDestructive gates outside paths', () => {
    const ok = { inside: false, isOwner: true, optIn: true, confirmed: true, label: 'x' };
    assert.equal(checkDestructive({ ...ok, inside: true, isOwner: false, optIn: false }), null);
    assert.match(checkDestructive({ ...ok, isOwner: false }), /^Refused.*Only the owner/);
    assert.match(checkDestructive({ ...ok, optIn: false }), /^Refused.*disabled/);
    assert.match(checkDestructive({ ...ok, confirmed: false }), /^CONFIRM_REQUIRED/);
    assert.match(checkDestructive({ ...ok, autoHealActive: true }), /auto-heal/);
    assert.equal(checkDestructive(ok), null);
});

test('end to end: deleting through symlinked dir is gated', () => {
    const r = resolveGuarded('linkdir/secret.txt', root, { noFollowLast: true });
    const denied = checkDestructive({ inside: r.inside, isOwner: false, optIn: false, confirmed: false, label: 'linkdir/secret.txt' });
    assert.ok(denied);
    assert.ok(fs.existsSync(path.join(outside, 'secret.txt')));
});

test.after(() => fs.rmSync(base, { recursive: true, force: true }));
