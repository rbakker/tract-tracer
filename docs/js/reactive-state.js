export class ReactiveState {
  // Private fields for internal state management
  #schema;
  #pipeline;
  #state = {};
  #derived = {};
  #subscribers = [];

  constructor(schema = {}, pipeline = []) {
    this.#schema = schema;
    this.#pipeline = pipeline;
    
    this.#init();
  }

  // Getter to securely expose the state structure if needed (mimics old .state)
  get state() {
    return this.#state;
  }

  // ── Internal Helpers ─────────────────────────────────────

  #init() {
    for (const [key, def] of Object.entries(this.#schema)) {
      this.#set(this.#state, key, structuredClone(def.default ?? null));
    }
  }

  // Reads dotted paths into a nested object
  #get(obj, path) {
    return path.split('.').reduce((o, k) => o?.[k], obj);
  }

  // Writes dotted paths into a nested object
  #set(obj, path, value) {
    const keys = path.split('.');
    let cursor = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (cursor[keys[i]] === undefined || typeof cursor[keys[i]] !== 'object') {
        cursor[keys[i]] = {};
      }
      cursor = cursor[keys[i]];
    }
    cursor[keys.at(-1)] = value;
  }

  #flush(dirtyTags) {
    if (dirtyTags.size === 0) return;
    //console.debug('[ReactiveState] dirty tags:', [...dirtyTags]);

    for (const { tag, fn } of this.#pipeline) {
      if (!dirtyTags.has(tag)) continue;
      try {
        fn();
      } catch (err) {
        console.error(`[ReactiveState] pipeline error in tag "${tag}":`, err);
      }
    }
  }

  // ── Public API ───────────────────────────────────────────

  // get (derived) state variable
  get(path) {
    const target = path in this.#schema ? this.#state : this.#derived;
    return this.#get(target, path);
  }

  // set (derived) state variable, do not run update pipeline
  set(path, value) {
    const target = path in this.#schema ? this.#state : this.#derived;
	//if (path in this.#schema) this.update({ [path]: value });
	//else 
	this.#set(target,path,value)
  }
  
  // update state variables and apply update pipeline.
  update(pathValuePairs) {
    if (!pathValuePairs || typeof pathValuePairs !== 'object') {
      console.warn('[ReactiveState] update: expected plain object');
      return;
    }

    const dirtyTags = new Set();

    for (const [path, value] of Object.entries(pathValuePairs)) {
      const schemaConfig = this.#schema[path];
      if (!schemaConfig) {
        console.warn(`[ReactiveState] Unknown key: "${path}" — ignored`);
        continue;
      }

      const prev = this.#get(this.#state, path);
      if (prev === value) continue; 

      this.#set(this.#state, path, value);
      schemaConfig.tags.forEach(t => dirtyTags.add(t));

      this.#subscribers.forEach(fn => fn(path, value, prev));
    }

    this.#flush(dirtyTags);
  }

  subscribe(fn) {
    this.#subscribers.push(fn);
    return () => {
      const index = this.#subscribers.indexOf(fn);
      if (index !== -1) this.#subscribers.splice(index, 1);
    };
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.#state, (k, v) =>
      v instanceof File || v instanceof Blob 
        ? `[${v.constructor.name} ${v.name ?? ''} ${v.size}b]` 
        : v
    ));
  }
}
