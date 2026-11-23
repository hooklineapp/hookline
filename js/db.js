// IndexedDB: bowlers, sessions, shots. Kleine Promise-Hülle ohne Bibliothek.
const NAME = 'hookline', VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('bowlers')) d.createObjectStore('bowlers', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' }).createIndex('date', 'date');
      if (!d.objectStoreNames.contains('shots')) {
        const s = d.createObjectStore('shots', { keyPath: 'id' });
        s.createIndex('session', 'sessionId'); s.createIndex('t', 't');
      }
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function store(name, mode = 'readonly') { return (await open()).transaction(name, mode).objectStore(name); }

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export async function put(name, obj) { return req((await store(name, 'readwrite')).put(obj)); }
export async function getOne(name, id) { return req((await store(name)).get(id)); }
export async function del(name, id) { return req((await store(name, 'readwrite')).delete(id)); }
export async function list(name) { return req((await store(name)).getAll()); }
export async function shotsOf(sessionId) {
  const s = await store('shots');
  const all = await req(s.index('session').getAll(sessionId));
  return all.sort((a, b) => a.t - b.t);
}
export async function kvGet(k) { return req((await store('kv')).get(k)); }
export async function kvSet(k, v) { return req((await store('kv', 'readwrite')).put(v, k)); }
export async function deleteSession(id) {
  for (const s of await shotsOf(id)) await del('shots', s.id);
  await del('sessions', id);
}
export async function clearAll() {
  const d = await open();
  for (const n of ['bowlers', 'sessions', 'shots']) await req(d.transaction(n, 'readwrite').objectStore(n).clear());
}
export async function exportAll() {
  return { app: 'hookline', version: 1, exported: new Date().toISOString(),
    bowlers: await list('bowlers'), sessions: await list('sessions'), shots: await list('shots') };
}
export async function importAll(data) {
  if (!data || !['hookline', 'bowltrack'].includes(data.app)) throw new Error('Keine Hookline-Datei');
  for (const b of data.bowlers || []) await put('bowlers', b);
  for (const s of data.sessions || []) await put('sessions', s);
  for (const s of data.shots || []) await put('shots', s);
  return (data.shots || []).length;
}
