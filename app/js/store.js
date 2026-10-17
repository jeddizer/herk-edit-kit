// On-device persistence: projects and their source clips live in IndexedDB.
const DB_NAME = "story-studio";
const VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
        if (!db.objectStoreNames.contains("media")) db.createObjectStore("media");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const listProjects = async () => {
  const all = await tx("projects", "readonly", (s) => s.getAll());
  return all.sort((a, b) => b.updated - a.updated);
};
export const getProject = (id) => tx("projects", "readonly", (s) => s.get(id));
export const saveProject = (p) => tx("projects", "readwrite", (s) => s.put({ ...p, updated: Date.now() }));
export const getMedia = (id) => tx("media", "readonly", (s) => s.get(id));
export const saveMedia = (id, blob) => tx("media", "readwrite", (s) => s.put(blob, id));
export const deleteMedia = (id) => tx("media", "readwrite", (s) => s.delete(id));
export async function deleteProject(id) {
  await tx("projects", "readwrite", (s) => s.delete(id));
  await tx("media", "readwrite", (s) => s.delete(id));
  // Recap projects keep one entry per shot under "<project id>:<item id>".
  await tx("media", "readwrite", (s) => s.delete(IDBKeyRange.bound(`${id}:`, `${id}:\uffff`)));
}

// Ask the browser not to evict saved clips under storage pressure.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // not supported
  }
}

const SETTINGS_KEY = "story-studio:settings";
export function loadPrefs() {
  try {
    return { provider: "groq", keys: {}, language: "", prompt: "", maxSeconds: 30, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { provider: "groq", keys: {}, language: "", prompt: "", maxSeconds: 30 };
  }
}
export function savePrefs(prefs) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs));
  } catch {
    // storage blocked; keep prefs for this session only
  }
}
