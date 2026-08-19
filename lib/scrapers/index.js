import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELOAD_DEBOUNCE_MS = 300;

function scandirSync(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.resolve(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(scandirSync(full));
    else results.push(full);
  }
  return results;
}

class Scraper {
  constructor(dir) {
    this.dir = dir;
    this._debounce = new Map();
    this.ready = this.init();
  }

  async init() {
    await this.load();
    this.watch();
  }

  async load() {
    try {
      const files = scandirSync(this.dir).filter(f => f.endsWith('.js'));
      await Promise.all(files.map(file => this._loadFile(file)));
    } catch (e) {
      console.error(e.message)
    }
  }

  async _loadFile(file) {
    const name = path.basename(file, '.js');
    try {
      const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
      this[name] = mod;
      return name;
    } catch (e) {
      console.error(e.message)
      return null;
    }
  }

  watch() {
    try {
      this._watcher = fs.watch(this.dir, { persistent: false, recursive: true }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.js')) return;
        this._scheduleReload(filename);
      });
    } catch (e) {
      try {
        this._watcher = fs.watch(this.dir, { persistent: false }, (eventType, filename) => {
          if (!filename || !filename.endsWith('.js')) return;
          this._scheduleReload(filename);
        });
      } catch (e2) {
         console.error(e2)
      }
    }
  }

  _scheduleReload(filename) {
    const prev = this._debounce.get(filename);
    if (prev) clearTimeout(prev);
    this._debounce.set(filename, setTimeout(() => this._reload(filename), RELOAD_DEBOUNCE_MS));
  }

  async _reload(filename) {
    this._debounce.delete(filename);
    const file = path.resolve(this.dir, filename);
    const name = path.basename(filename, '.js');
    if (fs.existsSync(file)) {
      const existed = name in this;
      const loaded = await this._loadFile(file);
      if (loaded) {
      }
    } else if (name in this) {
      delete this[name];
    }
  }
}

const scrapers = new Scraper(path.join(__dirname, 'src'));

export default scrapers;
