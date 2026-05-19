import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NoteStore } from './noteStore';

describe('NoteStore', () => {
    let dir: string;
    let store: NoteStore;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'caspian-notes-test-'));
        store = new NoteStore(dir);
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('list() returns empty when storage dir does not exist', async () => {
        await fs.rm(dir, { recursive: true, force: true });
        expect(await store.list()).toEqual([]);
    });

    it('list() returns empty when storage dir is empty', async () => {
        expect(await store.list()).toEqual([]);
    });

    it('create() persists a note and emits change', async () => {
        let changes = 0;
        store.onChange(() => changes++);

        const note = await store.create({ title: 'Hello', tags: ['a', 'b'], body: 'world' });

        expect(note.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(note.title).toBe('Hello');
        expect(note.tags).toEqual(['a', 'b']);
        expect(note.body).toBe('world');
        expect(changes).toBe(1);

        const list = await store.list();
        expect(list).toHaveLength(1);
        expect(list[0]?.id).toBe(note.id);
    });

    it('create() defaults Untitled when title is blank', async () => {
        const note = await store.create({ title: '   ', tags: [], body: 'x' });
        expect(note.title).toBe('Untitled');
    });

    it('create() lowercases, trims, and dedupes tags', async () => {
        const note = await store.create({
            title: 't',
            tags: ['Foo', 'foo', 'Bar', '  foo  ', '  '],
            body: '',
        });
        expect(note.tags).toEqual(['foo', 'bar']);
    });

    it('update() patches fields and bumps updatedAt', async () => {
        const note = await store.create({ title: 'A', tags: ['x'], body: 'orig' });
        await new Promise((r) => setTimeout(r, 5));
        const updated = await store.update(note.id, { body: 'new' });

        expect(updated?.body).toBe('new');
        expect(updated?.title).toBe('A');
        expect(updated?.tags).toEqual(['x']);
        expect(updated?.updatedAt).not.toBe(note.updatedAt);
        expect(updated?.createdAt).toBe(note.createdAt);
    });

    it('update() with blank title falls back to Untitled', async () => {
        const note = await store.create({ title: 'A', tags: [], body: '' });
        const updated = await store.update(note.id, { title: '   ' });
        expect(updated?.title).toBe('Untitled');
    });

    it('update() returns undefined for unknown id', async () => {
        const result = await store.update('does-not-exist', { body: 'x' });
        expect(result).toBeUndefined();
    });

    it('delete() removes the note and emits change', async () => {
        const note = await store.create({ title: 't', tags: [], body: '' });
        let changes = 0;
        store.onChange(() => changes++);

        await store.delete(note.id);

        expect(await store.get(note.id)).toBeUndefined();
        expect(await store.list()).toEqual([]);
        expect(changes).toBe(1);
    });

    it('delete() of unknown id is a no-op', async () => {
        await expect(store.delete('does-not-exist')).resolves.toBeUndefined();
    });

    it('list() sorts by updatedAt descending', async () => {
        const a = await store.create({ title: 'A', tags: [], body: '' });
        await new Promise((r) => setTimeout(r, 5));
        const b = await store.create({ title: 'B', tags: [], body: '' });
        await new Promise((r) => setTimeout(r, 5));
        await store.update(a.id, { body: 'updated' });

        const list = await store.list();
        expect(list.map((n) => n.id)).toEqual([a.id, b.id]);
    });

    it('pinned notes sort first, regardless of updatedAt', async () => {
        const a = await store.create({ title: 'A', tags: [], body: '' });
        await new Promise((r) => setTimeout(r, 5));
        const b = await store.create({ title: 'B', tags: [], body: '' });
        // Pin the older note
        await store.update(a.id, { pinned: true });

        const list = await store.list();
        expect(list.map((n) => n.id)).toEqual([a.id, b.id]);
    });

    it('toggling pinned bumps updatedAt (so cloud sync picks it up)', async () => {
        // Cloud-sync v1: the inbound poll keys on `updatedAt > cursor`, so
        // pin-only changes have to bump updatedAt or they wouldn't sync
        // until the next non-pin edit. Tradeoff: a freshly-pinned note
        // jumps to the top of the pinned bucket (the unpinned bucket is
        // unaffected because pin sorts ahead of recency).
        const note = await store.create({ title: 'A', tags: [], body: '' });
        const before = note.updatedAt;
        await new Promise((r) => setTimeout(r, 5));
        const updated = await store.update(note.id, { pinned: true });
        expect(updated?.pinned).toBe(true);
        expect(updated?.updatedAt).not.toBe(before);
    });

    it('changing body together with pinned bumps updatedAt', async () => {
        const note = await store.create({ title: 'A', tags: [], body: 'orig' });
        await new Promise((r) => setTimeout(r, 5));
        const updated = await store.update(note.id, { body: 'new', pinned: true });
        expect(updated?.pinned).toBe(true);
        expect(updated?.updatedAt).not.toBe(note.updatedAt);
    });

    it('new notes default to pinned: false', async () => {
        const note = await store.create({ title: 'A', tags: [], body: '' });
        expect(note.pinned).toBe(false);
    });

    it('round-trips a note through get()', async () => {
        const created = await store.create({
            title: 'Round trip',
            tags: ['x', 'y'],
            body: 'body line 1\nbody line 2',
        });
        const fetched = await store.get(created.id);
        expect(fetched).toEqual(created);
    });

    it('emits parseError for malformed frontmatter and skips the file', async () => {
        await fs.mkdir(dir, { recursive: true });
        // Unclosed flow mapping in frontmatter — js-yaml throws on this.
        await fs.writeFile(
            path.join(dir, 'broken.md'),
            '---\nfoo: { bar:\n---\nhello',
            'utf8',
        );

        const errors: Array<{ file: string; reason: string }> = [];
        store.onParseError((e) => errors.push(e));

        const list = await store.list();
        expect(list).toEqual([]);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.file).toContain('broken.md');
    });

    it('restore() re-creates a deleted note byte-for-byte', async () => {
        const note = await store.create({ title: 'Important', tags: ['x'], body: 'body' });
        await store.delete(note.id);
        expect(await store.get(note.id)).toBeUndefined();

        await store.restore(note);

        const back = await store.get(note.id);
        expect(back).toEqual(note); // id, createdAt, updatedAt all preserved
    });

    it('importNotes() assigns fresh ids and preserves payload', async () => {
        const original = await store.create({ title: 'A', tags: ['x'], body: 'body' });
        await store.update(original.id, { pinned: true });

        const exported = await store.list(); // round-trip via list

        const count = await store.importNotes(exported);
        expect(count).toBe(1);

        const after = await store.list();
        expect(after).toHaveLength(2); // original + imported
        const imported = after.find((n) => n.id !== original.id);
        expect(imported?.title).toBe('A');
        expect(imported?.body).toBe('body');
        expect(imported?.tags).toEqual(['x']);
        expect(imported?.pinned).toBe(true);
        expect(imported?.id).not.toBe(original.id);
    });

    it('importNotes() rejects non-objects gracefully', async () => {
        const count = await store.importNotes([null, 'string', 42, undefined]);
        expect(count).toBe(0);
        expect(await store.list()).toHaveLength(0);
    });

    it('non-markdown files in the dir are ignored', async () => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'README.txt'), 'not a note', 'utf8');
        await store.create({ title: 't', tags: [], body: 'b' });

        const list = await store.list();
        expect(list).toHaveLength(1);
        expect(list[0]?.title).toBe('t');
    });
});
